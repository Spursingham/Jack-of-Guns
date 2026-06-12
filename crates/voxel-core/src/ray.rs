//! Amanatides & Woo DDA voxel raycast.

use crate::{blocks, World};

pub struct RayHit {
    /// Hit voxel coordinates.
    pub block: [i32; 3],
    /// Face normal the ray entered through (unit axis), 0,0,0 if the ray
    /// started inside a solid voxel.
    pub normal: [i32; 3],
    /// Distance along the ray.
    pub t: f32,
    pub block_id: u8,
}

pub fn raycast(w: &World, origin: [f32; 3], dir: [f32; 3], max_dist: f32) -> Option<RayHit> {
    let len = (dir[0] * dir[0] + dir[1] * dir[1] + dir[2] * dir[2]).sqrt();
    if len < 1e-8 {
        return None;
    }
    let d = [dir[0] / len, dir[1] / len, dir[2] / len];

    let mut ip = [
        origin[0].floor() as i32,
        origin[1].floor() as i32,
        origin[2].floor() as i32,
    ];

    let b0 = w.get(ip[0], ip[1], ip[2]);
    if blocks::is_solid(b0) {
        return Some(RayHit {
            block: ip,
            normal: [0, 0, 0],
            t: 0.0,
            block_id: b0,
        });
    }

    let mut step = [0i32; 3];
    let mut t_max = [f32::INFINITY; 3];
    let mut t_delta = [f32::INFINITY; 3];
    for a in 0..3 {
        if d[a] > 1e-8 {
            step[a] = 1;
            t_max[a] = ((ip[a] + 1) as f32 - origin[a]) / d[a];
            t_delta[a] = 1.0 / d[a];
        } else if d[a] < -1e-8 {
            step[a] = -1;
            t_max[a] = (origin[a] - ip[a] as f32) / -d[a];
            t_delta[a] = 1.0 / -d[a];
        }
    }

    let mut t = 0.0f32;
    while t <= max_dist {
        // Step along the axis with the nearest crossing.
        let a = if t_max[0] < t_max[1] {
            if t_max[0] < t_max[2] {
                0
            } else {
                2
            }
        } else if t_max[1] < t_max[2] {
            1
        } else {
            2
        };
        t = t_max[a];
        if t > max_dist {
            return None;
        }
        ip[a] += step[a];
        t_max[a] += t_delta[a];

        let b = w.get(ip[0], ip[1], ip[2]);
        if blocks::is_solid(b) {
            let mut normal = [0i32; 3];
            normal[a] = -step[a];
            return Some(RayHit {
                block: ip,
                normal,
                t,
                block_id: b,
            });
        }
    }
    None
}
