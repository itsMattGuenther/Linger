//! Row → wire-type assembly. Plain async functions over the pools; if Postgres
//! ever happens (ARCHITECTURE §2 says ~never), this module is the seam.

pub mod attachments;
pub mod colors;
pub mod dms;
pub mod links;
pub mod media;
pub mod messages;
pub mod rooms;
pub mod search;
pub mod users;
