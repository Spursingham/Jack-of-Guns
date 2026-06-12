# ---- Rust: wasm module + game server ---------------------------------------
FROM rust:1.94-slim AS rust-build
WORKDIR /app
RUN rustup target add wasm32-unknown-unknown \
 && cargo install wasm-bindgen-cli --version 0.2.123 --locked
COPY Cargo.toml ./
COPY crates ./crates
RUN cargo build -p voxel-wasm --release --target wasm32-unknown-unknown \
 && wasm-bindgen --target web --out-dir /app/pkg \
      target/wasm32-unknown-unknown/release/voxel_wasm.wasm \
 && cargo build -p server --release

# ---- Node: client bundle -----------------------------------------------------
FROM node:22-slim AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY --from=rust-build /app/pkg ./src/wasm/pkg
RUN npx tsc --noEmit && npx vite build

# ---- Runtime ------------------------------------------------------------------
FROM debian:bookworm-slim
WORKDIR /app
COPY --from=rust-build /app/target/release/jack-of-guns-server ./
COPY --from=web-build /app/dist ./dist
ENV PORT=8080 STATIC_DIR=dist
EXPOSE 8080
CMD ["./jack-of-guns-server"]
