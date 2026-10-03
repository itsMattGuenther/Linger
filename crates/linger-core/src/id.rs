//! Typed identifiers (ARCHITECTURE §4).
//!
//! UUIDv7 everywhere: time-sortable so `ORDER BY id` is chronological and pagination
//! is a range scan. Stored in SQLite as `BLOB(16)`; rendered on the wire as 32 chars
//! of lowercase hex (no hyphens). Each entity gets its own newtype so a `RoomId`
//! can never be passed where a `UserId` belongs — and per the vocabulary rule,
//! it is `RoomId`, never `ChannelId`.

use std::fmt;
use std::str::FromStr;
use uuid::Uuid;

/// Errors from parsing a wire/database identifier.
#[derive(Debug, thiserror::Error)]
pub enum IdError {
    #[error("invalid id: not lowercase hex uuid")]
    Parse,
    #[error("invalid id: expected 16 bytes, got {0}")]
    Length(usize),
}

macro_rules! define_id {
    ($(#[$doc:meta])* $name:ident) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, ts_rs::TS)]
        #[ts(export)]
        pub struct $name(#[ts(type = "string")] pub Uuid);

        impl $name {
            /// Mint a new time-ordered (UUIDv7) identifier.
            #[must_use]
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }

            /// The 16-byte form stored in SQLite `BLOB(16)` columns.
            #[must_use]
            pub fn as_bytes(&self) -> &[u8; 16] {
                self.0.as_bytes()
            }

            /// Owned bytes, convenient for query binding.
            #[must_use]
            pub fn to_vec(&self) -> Vec<u8> {
                self.0.as_bytes().to_vec()
            }

            /// Rebuild from a `BLOB(16)` column value.
            pub fn from_slice(bytes: &[u8]) -> Result<Self, IdError> {
                Uuid::from_slice(bytes)
                    .map(Self)
                    .map_err(|_| IdError::Length(bytes.len()))
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }

        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                write!(f, "{}", self.0.as_simple())
            }
        }

        impl FromStr for $name {
            type Err = IdError;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                // Accepts simple (32 hex) and hyphenated forms; we only ever emit simple.
                Uuid::parse_str(s).map(Self).map_err(|_| IdError::Parse)
            }
        }

        impl serde::Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, ser: S) -> Result<S::Ok, S::Error> {
                ser.collect_str(&self.0.as_simple())
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(de: D) -> Result<Self, D::Error> {
                struct V;
                impl serde::de::Visitor<'_> for V {
                    type Value = $name;
                    fn expecting(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                        f.write_str("a lowercase hex uuid string")
                    }
                    fn visit_str<E: serde::de::Error>(self, s: &str) -> Result<$name, E> {
                        s.parse().map_err(|_| E::custom("invalid id"))
                    }
                }
                de.deserialize_str(V)
            }
        }
    };
}

define_id!(
    /// A member of the server.
    UserId
);
define_id!(
    /// A room. It is `RoomId`, never `ChannelId` (SPEC §1 vocabulary).
    RoomId
);
define_id!(
    /// A message in a room.
    MessageId
);
define_id!(
    /// An uploaded file (an item in the media collection).
    AttachmentId
);
define_id!(
    /// An in-flight upload slot.
    UploadId
);
define_id!(
    /// One member's request for an archive of the whole server (SPEC §4.11).
    ExportId
);
define_id!(
    /// A report a member sent the host (SPEC §4.15, PROTOCOL §5, T-1605).
    ReportId
);

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_time_ordered() {
        // UUIDv7 sorts chronologically — pagination depends on this property.
        let a = MessageId::new();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let b = MessageId::new();
        assert!(a < b);
    }

    #[test]
    fn wire_form_is_simple_lowercase_hex() {
        let id = UserId::new();
        let s = id.to_string();
        assert_eq!(s.len(), 32);
        assert!(s
            .chars()
            .all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
        assert_eq!(s.parse::<UserId>().unwrap(), id);
    }

    #[test]
    fn serde_round_trips_through_json() {
        let id = RoomId::new();
        let json = serde_json::to_string(&id).unwrap();
        assert_eq!(json, format!("\"{id}\""));
        let back: RoomId = serde_json::from_str(&json).unwrap();
        assert_eq!(back, id);
    }

    #[test]
    fn blob_round_trip() {
        let id = AttachmentId::new();
        let bytes = id.to_vec();
        assert_eq!(bytes.len(), 16);
        assert_eq!(AttachmentId::from_slice(&bytes).unwrap(), id);
        assert!(AttachmentId::from_slice(&bytes[..8]).is_err());
    }
}
