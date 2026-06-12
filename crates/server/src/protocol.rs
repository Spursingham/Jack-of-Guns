//! Binary wire protocol (little-endian). Mirrored byte-for-byte by
//! `src/net/protocol.ts` on the client — keep the two in sync.
//!
//! C2S: 0x01 Join, 0x02 State, 0x03 SetBlock, 0x04 Shoot, 0x05 Respawn,
//!      0x06 ThrowGrenade, 0x07 FireRocket
//! S2C: 0x80 Welcome, 0x81 PlayerJoined, 0x82 PlayerLeft, 0x83 Snapshot,
//!      0x84 BlockSet, 0x85 Shot, 0x86 Explosion, 0x87 Damage, 0x88 Death,
//!      0x89 Spawn, 0x8A GrenadeThrown, 0x8B RocketFired

#![allow(dead_code)]

pub const C2S_JOIN: u8 = 0x01;
pub const C2S_STATE: u8 = 0x02;
pub const C2S_SET_BLOCK: u8 = 0x03;
pub const C2S_SHOOT: u8 = 0x04;
pub const C2S_RESPAWN: u8 = 0x05;
pub const C2S_THROW_GRENADE: u8 = 0x06;
pub const C2S_FIRE_ROCKET: u8 = 0x07;

pub const S2C_WELCOME: u8 = 0x80;
pub const S2C_PLAYER_JOINED: u8 = 0x81;
pub const S2C_PLAYER_LEFT: u8 = 0x82;
pub const S2C_SNAPSHOT: u8 = 0x83;
pub const S2C_BLOCK_SET: u8 = 0x84;
pub const S2C_SHOT: u8 = 0x85;
pub const S2C_EXPLOSION: u8 = 0x86;
pub const S2C_DAMAGE: u8 = 0x87;
pub const S2C_DEATH: u8 = 0x88;
pub const S2C_SPAWN: u8 = 0x89;
pub const S2C_GRENADE_THROWN: u8 = 0x8A;
pub const S2C_ROCKET_FIRED: u8 = 0x8B;

/// Weapon / cause ids (shared with the client).
pub const W_RIFLE: u8 = 0;
pub const W_AR: u8 = 1;
pub const W_ROCKET: u8 = 2;
pub const W_SHOTGUN: u8 = 3;
pub const W_PISTOL: u8 = 4;
pub const W_SPADE: u8 = 5;
pub const W_GRENADE: u8 = 6;
pub const W_PICKAXE: u8 = 7;
pub const CAUSE_GRENADE: u8 = 8;
pub const CAUSE_ROCKET: u8 = 9;

#[derive(Default)]
pub struct Writer {
    pub buf: Vec<u8>,
}

impl Writer {
    pub fn new(msg_type: u8) -> Writer {
        Writer { buf: vec![msg_type] }
    }
    pub fn u8(&mut self, v: u8) -> &mut Self {
        self.buf.push(v);
        self
    }
    pub fn u16(&mut self, v: u16) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn u32(&mut self, v: u32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn f32(&mut self, v: f32) -> &mut Self {
        self.buf.extend_from_slice(&v.to_le_bytes());
        self
    }
    pub fn str8(&mut self, s: &str) -> &mut Self {
        let b = s.as_bytes();
        let n = b.len().min(255);
        self.buf.push(n as u8);
        self.buf.extend_from_slice(&b[..n]);
        self
    }
}

pub struct Reader<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Reader<'a> {
    pub fn new(buf: &'a [u8]) -> Reader<'a> {
        Reader { buf, pos: 0 }
    }
    pub fn remaining(&self) -> usize {
        self.buf.len().saturating_sub(self.pos)
    }
    pub fn u8(&mut self) -> Option<u8> {
        let v = *self.buf.get(self.pos)?;
        self.pos += 1;
        Some(v)
    }
    pub fn u16(&mut self) -> Option<u16> {
        let b = self.buf.get(self.pos..self.pos + 2)?;
        self.pos += 2;
        Some(u16::from_le_bytes([b[0], b[1]]))
    }
    pub fn u32(&mut self) -> Option<u32> {
        let b = self.buf.get(self.pos..self.pos + 4)?;
        self.pos += 4;
        Some(u32::from_le_bytes([b[0], b[1], b[2], b[3]]))
    }
    pub fn f32(&mut self) -> Option<f32> {
        Some(f32::from_bits(self.u32()?))
    }
    pub fn vec3(&mut self) -> Option<[f32; 3]> {
        Some([self.f32()?, self.f32()?, self.f32()?])
    }
    pub fn str8(&mut self) -> Option<String> {
        let n = self.u8()? as usize;
        let b = self.buf.get(self.pos..self.pos + n)?;
        self.pos += n;
        Some(String::from_utf8_lossy(b).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn writer_reader_roundtrip() {
        let mut w = Writer::new(0x42);
        w.u8(7).u16(65500).u32(0xdead_beef).f32(-1.5).str8("jack");
        let buf = w.buf;
        let mut r = Reader::new(&buf);
        assert_eq!(r.u8(), Some(0x42));
        assert_eq!(r.u8(), Some(7));
        assert_eq!(r.u16(), Some(65500));
        assert_eq!(r.u32(), Some(0xdead_beef));
        assert_eq!(r.f32(), Some(-1.5));
        assert_eq!(r.str8(), Some("jack".into()));
        assert_eq!(r.u8(), None, "exhausted");
    }

    #[test]
    fn reader_handles_truncated_input() {
        let mut r = Reader::new(&[0x01, 0x02]);
        assert_eq!(r.u8(), Some(1));
        assert_eq!(r.u32(), None);
        // str8 with length byte exceeding data
        let mut r = Reader::new(&[5, b'a', b'b']);
        assert_eq!(r.str8(), None);
    }
}
