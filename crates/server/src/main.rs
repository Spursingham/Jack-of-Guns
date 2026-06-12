//! Jack of Guns — authoritative game server.
//! Serves the built client from `dist/` and runs the simulation behind a
//! `/ws` WebSocket endpoint (binary protocol, see `protocol.rs`).

mod game;
mod protocol;

use axum::{
    extract::ws::{Message, WebSocket, WebSocketUpgrade},
    extract::State,
    response::IntoResponse,
    routing::get,
    Router,
};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tower_http::services::ServeDir;

#[derive(Clone)]
struct AppState {
    game_tx: mpsc::UnboundedSender<game::Cmd>,
}

#[tokio::main]
async fn main() {
    let port: u16 = std::env::var("PORT").ok().and_then(|v| v.parse().ok()).unwrap_or(8080);
    let seed: u32 = std::env::var("SEED").ok().and_then(|v| v.parse().ok()).unwrap_or(1337);
    let static_dir = std::env::var("STATIC_DIR").unwrap_or_else(|_| "dist".into());

    let (game_tx, game_rx) = mpsc::unbounded_channel();
    tokio::spawn(game::run(seed, game_rx));

    let app = Router::new()
        .route("/ws", get(ws_handler))
        .route("/healthz", get(|| async { "ok" }))
        .fallback_service(ServeDir::new(&static_dir))
        .with_state(AppState { game_tx });

    let addr = format!("0.0.0.0:{port}");
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    println!("[server] listening on http://{addr} (static: {static_dir})");
    axum::serve(listener, app).await.expect("serve");
}

async fn ws_handler(ws: WebSocketUpgrade, State(st): State<AppState>) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, st))
}

async fn handle_socket(socket: WebSocket, st: AppState) {
    let (mut tx, mut rx) = socket.split();

    // First message must be Join (10s grace).
    let first = tokio::time::timeout(std::time::Duration::from_secs(10), rx.next()).await;
    let Ok(Some(Ok(Message::Binary(join_buf)))) = first else {
        let _ = tx.close().await;
        return;
    };
    let mut r = protocol::Reader::new(&join_buf);
    if r.u8() != Some(protocol::C2S_JOIN) {
        let _ = tx.close().await;
        return;
    }
    let class = r.u8().unwrap_or(0);
    let name = r.str8().unwrap_or_default();

    let (out_tx, mut out_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (reply_tx, reply_rx) = tokio::sync::oneshot::channel();
    if st
        .game_tx
        .send(game::Cmd::Join { name, class, out: out_tx, reply: reply_tx })
        .is_err()
    {
        return;
    }
    let Ok(Some(id)) = reply_rx.await else {
        // Server full.
        let _ = tx.close().await;
        return;
    };

    // Writer: game -> socket.
    let writer = tokio::spawn(async move {
        while let Some(buf) = out_rx.recv().await {
            if tx.send(Message::Binary(buf.into())).await.is_err() {
                break;
            }
        }
        let _ = tx.close().await;
    });

    // Reader: socket -> game.
    while let Some(Ok(msg)) = rx.next().await {
        match msg {
            Message::Binary(buf) => {
                if buf.len() > 512 {
                    continue;
                }
                if st.game_tx.send(game::Cmd::Msg(id, buf.to_vec())).is_err() {
                    break;
                }
            }
            Message::Close(_) => break,
            _ => {}
        }
    }

    let _ = st.game_tx.send(game::Cmd::Leave(id));
    writer.abort();
}
