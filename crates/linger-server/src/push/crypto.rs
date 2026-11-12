//! A notification encrypted to one phone: RFC 8291 ("Message Encryption for
//! Web Push") with RFC 8188's `aes128gcm` content coding, one record.
//!
//! This is the standard web push encryption, not something made up for
//! Linger (#830). The phone made a P-256 key pair and a 16-byte secret and
//! gave the server the public half; the server makes a fresh key pair for
//! each notification, agrees a key with the phone's, and encrypts with it.
//! Only the phone's private key opens the result, so the relay, Apple and
//! Google carry it without reading it. The relay never sees the phone's key
//! at all.
//!
//! `aes128gcm` is what every web push library reads, so the phone's side
//! (Kotlin on Android, Swift in the iPhone's notification extension) is the
//! RFC's decryption, checked against the RFC's own example as this is.

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes128Gcm, Nonce};
use hkdf::Hkdf;
use p256::elliptic_curve::sec1::ToEncodedPoint;
use p256::{PublicKey, SecretKey};
use rand::RngCore;
use sha2::Sha256;

/// The record size written into the header. One record holds the whole
/// notification, which `PADDED_TO` keeps far below it.
const RECORD_SIZE: u32 = 4096;

/// What every notification's words are padded to, at least: a multiple of
/// this many bytes. The ciphertext's length then says little about how long
/// the message was to anybody who carries it.
pub const PADDED_TO: usize = 256;

/// Why a phone's key can't be encrypted to.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum KeyError {
    #[error("the public key isn't a P-256 point")]
    PublicKey,
    #[error("the notification is too long for one record")]
    TooLong,
}

/// Check a phone's public key before it's stored, so a bad one is refused
/// when the phone registers rather than failing every notification after.
pub fn check_public_key(ua_public: &[u8]) -> Result<(), KeyError> {
    point(ua_public).map(|_| ())
}

fn point(ua_public: &[u8]) -> Result<PublicKey, KeyError> {
    // Uncompressed only, as RFC 8291 sends it: 0x04, then x and y.
    if ua_public.len() != 65 || ua_public[0] != 0x04 {
        return Err(KeyError::PublicKey);
    }
    PublicKey::from_sec1_bytes(ua_public).map_err(|_| KeyError::PublicKey)
}

/// Encrypt `plaintext` to the phone whose key is `ua_public` and whose
/// secret is `auth_secret`, padded to a multiple of [`PADDED_TO`].
pub fn encrypt(
    ua_public: &[u8],
    auth_secret: &[u8; 16],
    plaintext: &[u8],
) -> Result<Vec<u8>, KeyError> {
    let as_private = SecretKey::random(&mut rand::rngs::OsRng);
    let mut salt = [0u8; 16];
    rand::rngs::OsRng.fill_bytes(&mut salt);
    let padding = (plaintext.len() + 1).next_multiple_of(PADDED_TO) - (plaintext.len() + 1);
    seal(
        &as_private,
        &salt,
        ua_public,
        auth_secret,
        plaintext,
        padding,
    )
}

/// [`encrypt`] with its two random inputs given, which is what lets the
/// RFC's example be checked byte for byte.
fn seal(
    as_private: &SecretKey,
    salt: &[u8; 16],
    ua_public: &[u8],
    auth_secret: &[u8; 16],
    plaintext: &[u8],
    padding: usize,
) -> Result<Vec<u8>, KeyError> {
    let phone = point(ua_public)?;
    let as_public = as_private.public_key().to_encoded_point(false);
    let as_public = as_public.as_bytes();

    // RFC 8291 §3.3: combine the shared secret with the phone's secret.
    let shared = p256::ecdh::diffie_hellman(as_private.to_nonzero_scalar(), phone.as_affine());
    let mut key_info = Vec::with_capacity(14 + 65 + 65);
    key_info.extend_from_slice(b"WebPush: info\0");
    key_info.extend_from_slice(ua_public);
    key_info.extend_from_slice(as_public);
    let mut ikm = [0u8; 32];
    Hkdf::<Sha256>::new(Some(auth_secret), shared.raw_secret_bytes())
        .expand(&key_info, &mut ikm)
        .map_err(|_| KeyError::TooLong)?;

    // RFC 8188 §2.2 and §2.3: the content key and the nonce, from the salt.
    let content = Hkdf::<Sha256>::new(Some(salt), &ikm);
    let mut cek = [0u8; 16];
    let mut nonce = [0u8; 12];
    content
        .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
        .map_err(|_| KeyError::TooLong)?;
    content
        .expand(b"Content-Encoding: nonce\0", &mut nonce)
        .map_err(|_| KeyError::TooLong)?;

    // One record, the last: the words, the delimiter 0x02, then zeros.
    let mut record = Vec::with_capacity(plaintext.len() + 1 + padding);
    record.extend_from_slice(plaintext);
    record.push(0x02);
    record.resize(plaintext.len() + 1 + padding, 0);
    if record.len() + 16 > RECORD_SIZE as usize {
        return Err(KeyError::TooLong);
    }
    let cipher = Aes128Gcm::new_from_slice(&cek).map_err(|_| KeyError::TooLong)?;
    let sealed = cipher
        .encrypt(Nonce::from_slice(&nonce), record.as_slice())
        .map_err(|_| KeyError::TooLong)?;

    // The header (RFC 8188 §2.1): salt, record size, and the server's key
    // as the key id (RFC 8291 §4).
    let mut out = Vec::with_capacity(16 + 4 + 1 + 65 + sealed.len());
    out.extend_from_slice(salt);
    out.extend_from_slice(&RECORD_SIZE.to_be_bytes());
    out.push(65);
    out.extend_from_slice(as_public);
    out.extend_from_slice(&sealed);
    Ok(out)
}

#[cfg(test)]
mod tests {
    use base64::engine::general_purpose::URL_SAFE_NO_PAD;
    use base64::Engine as _;

    use super::*;

    fn b64(text: &str) -> Vec<u8> {
        let joined: String = text.split_whitespace().collect();
        URL_SAFE_NO_PAD.decode(joined).unwrap()
    }

    /// RFC 8291 §5 and Appendix A, byte for byte: the RFC's own keys, salt
    /// and words give the RFC's own message.
    #[test]
    fn matches_rfc_8291_s_example() {
        let as_private =
            SecretKey::from_slice(&b64("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw")).unwrap();
        let as_public = b64("BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIg
             Dll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8");
        assert_eq!(
            as_private.public_key().to_encoded_point(false).as_bytes(),
            as_public.as_slice()
        );
        let ua_public = b64("BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcx
             aOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4");
        let salt: [u8; 16] = b64("DGv6ra1nlYgDCS1FRnbzlw").try_into().unwrap();
        let auth: [u8; 16] = b64("BTBZMqHH6r4Tts7J_aSIgg").try_into().unwrap();
        let plaintext = b64("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24");
        assert_eq!(plaintext, b"When I grow up, I want to be a watermelon");

        let message = seal(&as_private, &salt, &ua_public, &auth, &plaintext, 0).unwrap();

        // The RFC prints the 86-byte header and the ciphertext apart.
        let header = b64(
            "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27ml
             mlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
        );
        let ciphertext = b64(
            "8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEs
             bI_0LpXMuGvnzQ",
        );
        assert_eq!(header.len(), 86);
        assert_eq!(message[..86], header[..]);
        assert_eq!(message[86..], ciphertext[..]);
    }

    /// The phone's side, the RFC's decryption, opens what [`encrypt`] makes,
    /// padding and all; and a different secret doesn't.
    #[test]
    fn the_phone_s_key_opens_it_and_nothing_else_does() {
        let phone = SecretKey::random(&mut rand::rngs::OsRng);
        let phone_public = phone.public_key().to_encoded_point(false);
        let auth = [7u8; 16];
        let words = br#"{"v":1,"title":"Sam in #general","body":"you around tonight?"}"#;

        let message = encrypt(phone_public.as_bytes(), &auth, words).unwrap();
        assert_eq!((message.len() - 86 - 16) % PADDED_TO, 0, "padded");
        assert_eq!(open(&phone, &auth, &message).unwrap(), words);
        assert!(open(&phone, &[8u8; 16], &message).is_none());
        let stranger = SecretKey::random(&mut rand::rngs::OsRng);
        assert!(open(&stranger, &auth, &message).is_none());
    }

    #[test]
    fn a_key_that_isn_t_a_point_is_refused() {
        assert_eq!(check_public_key(&[4u8; 65]), Err(KeyError::PublicKey));
        assert_eq!(check_public_key(&[4u8; 33]), Err(KeyError::PublicKey));
        let real = SecretKey::random(&mut rand::rngs::OsRng).public_key();
        let compressed = real.to_encoded_point(true);
        assert_eq!(
            check_public_key(compressed.as_bytes()),
            Err(KeyError::PublicKey)
        );
        assert_eq!(
            check_public_key(real.to_encoded_point(false).as_bytes()),
            Ok(())
        );
    }

    /// RFC 8291's decryption, as a phone does it.
    fn open(phone: &SecretKey, auth: &[u8; 16], message: &[u8]) -> Option<Vec<u8>> {
        let salt = &message[..16];
        let id_len = message[20] as usize;
        let as_public = PublicKey::from_sec1_bytes(&message[21..21 + id_len]).ok()?;
        let body = &message[21 + id_len..];
        let ua_public = phone.public_key().to_encoded_point(false);
        let shared = p256::ecdh::diffie_hellman(phone.to_nonzero_scalar(), as_public.as_affine());
        let mut info = b"WebPush: info\0".to_vec();
        info.extend_from_slice(ua_public.as_bytes());
        info.extend_from_slice(&message[21..21 + id_len]);
        let mut ikm = [0u8; 32];
        Hkdf::<Sha256>::new(Some(auth), shared.raw_secret_bytes())
            .expand(&info, &mut ikm)
            .ok()?;
        let content = Hkdf::<Sha256>::new(Some(salt), &ikm);
        let mut cek = [0u8; 16];
        let mut nonce = [0u8; 12];
        content
            .expand(b"Content-Encoding: aes128gcm\0", &mut cek)
            .ok()?;
        content
            .expand(b"Content-Encoding: nonce\0", &mut nonce)
            .ok()?;
        let mut record = Aes128Gcm::new_from_slice(&cek)
            .ok()?
            .decrypt(Nonce::from_slice(&nonce), body)
            .ok()?;
        while record.last() == Some(&0) {
            record.pop();
        }
        (record.pop() == Some(0x02)).then_some(record)
    }
}
