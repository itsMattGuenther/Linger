//! The upload pipeline, end to end over real HTTP (T-501).
//!
//! The three things T-501 promised to prove are
//! `a_killed_upload_resumes_and_completes`, `exif_never_survives_an_upload`
//! and `a_file_that_lies_about_its_type_is_refused`. The rest guard the
//!边 cases around them.

mod common;

use common::{
    bootstrap_host, join_member, server_with_room, spawn_server, spawn_tuned, TestServer,
};
use linger_core::wire::{Attachment, AuthResponse, CompletedPart, Message, UploadSlot};
use reqwest::StatusCode;

const PART: u64 = 8 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn client() -> reqwest::Client {
    reqwest::Client::new()
}

/// `POST /uploads`, returning the raw response so tests can assert on refusals.
async fn ask_for_slot(
    server: &TestServer,
    token: &str,
    filename: &str,
    size_bytes: u64,
    mime: &str,
) -> reqwest::Response {
    client()
        .post(server.url("/uploads"))
        .bearer_auth(token)
        .json(&serde_json::json!({
            "filename": filename,
            "size_bytes": size_bytes,
            "mime": mime,
        }))
        .send()
        .await
        .unwrap()
}

async fn slot(
    server: &TestServer,
    token: &str,
    filename: &str,
    size_bytes: u64,
    mime: &str,
) -> UploadSlot {
    let resp = ask_for_slot(server, token, filename, size_bytes, mime).await;
    assert_eq!(
        resp.status(),
        200,
        "slot refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

/// The slot URLs are root-relative when the server has no configured domain,
/// which is every test server.
fn absolute(server: &TestServer, url: &str) -> String {
    format!("{}{url}", server.base)
}

async fn put_part(server: &TestServer, url: &str, bytes: Vec<u8>) -> (StatusCode, Option<String>) {
    let resp = client()
        .put(absolute(server, url))
        .body(bytes)
        .send()
        .await
        .unwrap();
    let etag = resp
        .headers()
        .get(reqwest::header::ETAG)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);
    (resp.status(), etag)
}

async fn finish(
    server: &TestServer,
    token: &str,
    slot: &UploadSlot,
    parts: Option<Vec<CompletedPart>>,
) -> reqwest::Response {
    client()
        .post(server.url(&format!("/uploads/{}/complete", slot.upload_id)))
        .bearer_auth(token)
        .json(&serde_json::json!({ "parts": parts }))
        .send()
        .await
        .unwrap()
}

/// Slot, PUT, complete — the whole happy path in one call.
async fn upload(
    server: &TestServer,
    token: &str,
    filename: &str,
    mime: &str,
    bytes: Vec<u8>,
) -> Attachment {
    let slot = slot(server, token, filename, bytes.len() as u64, mime).await;
    let (status, _) = put_part(server, &slot.url, bytes).await;
    assert_eq!(status, 200);
    let resp = finish(server, token, &slot, None).await;
    assert_eq!(
        resp.status(),
        200,
        "complete refused: {}",
        resp.text().await.unwrap()
    );
    resp.json().await.unwrap()
}

async fn error_code(resp: reqwest::Response) -> String {
    let body: serde_json::Value = resp.json().await.unwrap();
    body["error"]["code"].as_str().unwrap().to_string()
}

// ---------------------------------------------------------------------------
// Test files
// ---------------------------------------------------------------------------

fn png(width: u32, height: u32) -> Vec<u8> {
    let mut canvas = image::RgbaImage::new(width, height);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x % 256) as u8, (y % 256) as u8);
        *pixel = image::Rgba([r, g, 200, 255]);
    }
    let mut out = Vec::new();
    image::DynamicImage::ImageRgba8(canvas)
        .write_to(&mut std::io::Cursor::new(&mut out), image::ImageFormat::Png)
        .unwrap();
    out
}

/// The string planted in the EXIF block. If this survives an upload, somebody's
/// home address does too.
const EXIF_MARKER: &str = "LINGER_EXIF_MARKER_51.5074N_0.1278W";

/// A real JPEG carrying a real EXIF APP1 block with a GPS IFD in it.
fn jpeg_with_exif_gps() -> Vec<u8> {
    let mut plain = Vec::new();
    let mut canvas = image::RgbImage::new(24, 18);
    for (x, y, pixel) in canvas.enumerate_pixels_mut() {
        #[allow(clippy::cast_possible_truncation)]
        let (r, g) = ((x * 10 % 256) as u8, (y * 10 % 256) as u8);
        *pixel = image::Rgb([r, g, 90]);
    }
    image::DynamicImage::ImageRgb8(canvas)
        .write_to(
            &mut std::io::Cursor::new(&mut plain),
            image::ImageFormat::Jpeg,
        )
        .unwrap();

    // Little-endian TIFF: IFD0 with an ImageDescription and a pointer to a GPS
    // IFD, laid out by hand because no Rust crate writes EXIF.
    let description = format!("{EXIF_MARKER}\0");
    let ifd0_end = 8 + 2 + 2 * 12 + 4; // header + count + two entries + next
    let gps_ifd_at = ifd0_end + description.len();

    let mut tiff: Vec<u8> = Vec::new();
    tiff.extend_from_slice(b"II");
    tiff.extend_from_slice(&42u16.to_le_bytes());
    tiff.extend_from_slice(&8u32.to_le_bytes());
    tiff.extend_from_slice(&2u16.to_le_bytes());

    let mut entry = |tag: u16, kind: u16, count: u32, value: u32| {
        tiff.extend_from_slice(&tag.to_le_bytes());
        tiff.extend_from_slice(&kind.to_le_bytes());
        tiff.extend_from_slice(&count.to_le_bytes());
        tiff.extend_from_slice(&value.to_le_bytes());
    };
    #[allow(clippy::cast_possible_truncation)]
    entry(0x010E, 2, description.len() as u32, ifd0_end as u32); // ImageDescription
    #[allow(clippy::cast_possible_truncation)]
    entry(0x8825, 4, 1, gps_ifd_at as u32); // GPSInfo pointer

    tiff.extend_from_slice(&0u32.to_le_bytes()); // no IFD1
    tiff.extend_from_slice(description.as_bytes());

    // The GPS IFD itself: two short ASCII values, small enough to sit inline.
    tiff.extend_from_slice(&2u16.to_le_bytes());
    for (tag, value) in [(0x0001u16, b"N\0\0\0"), (0x0003u16, b"W\0\0\0")] {
        tiff.extend_from_slice(&tag.to_le_bytes());
        tiff.extend_from_slice(&2u16.to_le_bytes());
        tiff.extend_from_slice(&2u32.to_le_bytes());
        tiff.extend_from_slice(value);
    }
    tiff.extend_from_slice(&0u32.to_le_bytes());

    let mut app1 = b"Exif\0\0".to_vec();
    app1.extend_from_slice(&tiff);

    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE1];
    #[allow(clippy::cast_possible_truncation)]
    out.extend_from_slice(&((app1.len() + 2) as u16).to_be_bytes());
    out.extend_from_slice(&app1);
    out.extend_from_slice(&plain[2..]); // everything after the original SOI
    out
}

/// Bytes that are neither random nor compressible into nothing, so a multipart
/// test moves real data around.
fn filler(len: usize) -> Vec<u8> {
    (0..len)
        .map(|i| {
            #[allow(clippy::cast_possible_truncation)]
            let byte = (i * 31 % 251) as u8;
            byte
        })
        .collect()
}

// ---------------------------------------------------------------------------
// The happy path
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_image_goes_up_gets_described_and_lands_on_a_message() {
    let (server, host, room) = server_with_room("general").await;
    let attachment = upload(
        &server,
        &host.access_token,
        "holiday.png",
        "image/png",
        png(64, 48),
    )
    .await;

    assert_eq!(attachment.mime, "image/png");
    assert_eq!(attachment.filename, "holiday.png");
    assert_eq!((attachment.width, attachment.height), (Some(64), Some(48)));
    assert!(attachment.blurhash.is_some(), "images get a blurhash");
    assert_eq!(attachment.uploader_id, host.user.id);
    assert!(
        attachment.url.starts_with("/objects/"),
        "{}",
        attachment.url
    );

    // The bytes come back, in place, and with sniffing off.
    let served = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 200);
    assert_eq!(served.headers()["content-type"], "image/png");
    assert_eq!(served.headers()["x-content-type-options"], "nosniff");
    assert!(served.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("inline;"));
    let bytes = served.bytes().await.unwrap();
    assert_eq!(bytes.len() as u64, attachment.size_bytes);

    // And it can be posted, with no caption, which is how people share photos.
    let posted: Message = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .json(&serde_json::json!({ "body": "", "attachment_ids": [attachment.id] }))
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(posted.attachments.len(), 1);
    assert_eq!(posted.attachments[0].id, attachment.id);

    // It is still there when the room is paged in fresh.
    let page: Vec<Message> = client()
        .get(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(page[0].attachments.len(), 1);
}

/// A voice message (#401): Opus in WebM, as the app records it. The sniffer
/// calls any WebM a video, so this is the case that proves one declared as
/// sound goes up as sound and is played in place.
#[tokio::test]
async fn a_voice_message_goes_up_as_sound_and_plays_in_place() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let mut bytes = vec![0x1a, 0x45, 0xdf, 0xa3, 0x8f, 0x42, 0x86, 0x81, 0x01];
    bytes.extend_from_slice(&[0x42, 0x82, 0x84]);
    bytes.extend_from_slice(b"webm");
    bytes.extend_from_slice(&[0x42, 0x87, 0x81, 0x04]);
    bytes.extend(filler(2_000));
    let attachment = upload(
        &server,
        &host.access_token,
        "Voice message.webm",
        "audio/webm",
        bytes,
    )
    .await;
    assert_eq!(attachment.mime, "audio/webm");
    assert_eq!(attachment.filename, "Voice message.webm");

    let served = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap();
    assert_eq!(served.headers()["content-type"], "audio/webm");
    assert!(!served
        .headers()
        .get("content-disposition")
        .is_some_and(|value| value.to_str().unwrap_or("").starts_with("attachment")));
}

#[tokio::test]
async fn a_plain_file_is_handed_over_as_a_download() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let attachment = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        b"the tuesday plan\n".to_vec(),
    )
    .await;

    let served = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap();
    // Never echo the uploader's idea of what this is, and never let a browser
    // guess: that is what stops a stored file becoming a page.
    assert_eq!(served.headers()["content-type"], "application/octet-stream");
    assert_eq!(served.headers()["x-content-type-options"], "nosniff");
    assert!(served.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));
}

// ---------------------------------------------------------------------------
// Serving part of a file (#222)
// ---------------------------------------------------------------------------

/// A video as far as the server can tell: an MP4 `ftyp` box, which is what it
/// sniffs, then bytes nothing could play. ffprobe finding nothing in them is
/// the same path as a server without ffmpeg, so no toolchain is needed.
fn fake_video(len: usize) -> Vec<u8> {
    let mut bytes = vec![0, 0, 0, 0x18];
    bytes.extend_from_slice(b"ftypisom");
    let rest = len - bytes.len();
    bytes.extend(filler(rest));
    bytes
}

/// `GET` a served file, with a `Range` header or without one.
async fn fetch(url: &str, range: Option<&str>) -> reqwest::Response {
    let mut request = client().get(url);
    if let Some(range) = range {
        request = request.header(reqwest::header::RANGE, range);
    }
    request.send().await.unwrap()
}

const VIDEO_LEN: usize = 100_000;

/// A server with one video on it, its host, and where that video is served.
async fn server_with_video() -> (TestServer, AuthResponse, String, Vec<u8>) {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let video = fake_video(VIDEO_LEN);
    let attachment = upload(
        &server,
        &host.access_token,
        "clip.mp4",
        "video/mp4",
        video.clone(),
    )
    .await;
    assert_eq!(attachment.mime, "video/mp4");
    let url = absolute(&server, &attachment.url);
    (server, host, url, video)
}

#[tokio::test]
async fn a_video_is_served_in_the_pieces_a_player_asks_for() {
    let (_server, _host, url, video) = server_with_video().await;

    // Asked for nothing in particular: all of it, and word that pieces work.
    let whole = fetch(&url, None).await;
    assert_eq!(whole.status(), 200);
    assert_eq!(whole.headers()["accept-ranges"], "bytes");
    assert_eq!(whole.headers()["content-length"], VIDEO_LEN.to_string());
    assert!(whole.headers().get("content-range").is_none());
    assert_eq!(whole.bytes().await.unwrap(), video);

    for (range, start, end) in [
        // The first request a player makes, and a plain slice.
        ("bytes=0-", 0, VIDEO_LEN - 1),
        ("bytes=0-99", 0, 99),
        // A seek: from somewhere in the middle to the end.
        ("bytes=50000-", 50_000, VIDEO_LEN - 1),
        // The last n bytes, which is where an MP4's index often lives.
        ("bytes=-1000", VIDEO_LEN - 1000, VIDEO_LEN - 1),
        // Running past the end is cut to the end; asking for more than there
        // is gets all of it.
        ("bytes=99990-200000", 99_990, VIDEO_LEN - 1),
        ("bytes=-500000", 0, VIDEO_LEN - 1),
        // The last byte on its own.
        ("bytes=99999-99999", VIDEO_LEN - 1, VIDEO_LEN - 1),
    ] {
        let part = fetch(&url, Some(range)).await;
        assert_eq!(part.status(), 206, "{range}");
        assert_eq!(
            part.headers()["content-range"],
            format!("bytes {start}-{end}/{VIDEO_LEN}"),
            "{range}"
        );
        assert_eq!(
            part.headers()["content-length"],
            (end - start + 1).to_string(),
            "{range}"
        );
        assert_eq!(part.bytes().await.unwrap(), video[start..=end], "{range}");
    }
}

#[tokio::test]
async fn a_piece_goes_out_with_every_header_the_whole_file_does() {
    let (server, host, video_url, _) = server_with_video().await;
    let download = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        filler(4096),
    )
    .await;
    let download_url = absolute(&server, &download.url);

    // What keeps a hostile upload harmless has to hold for a slice of it too:
    // a browser treats a 206 as the same file.
    for url in [&video_url, &download_url] {
        let whole = fetch(url, None).await;
        let part = fetch(url, Some("bytes=10-19")).await;
        assert_eq!(part.status(), 206);
        for name in [
            "content-type",
            "x-content-type-options",
            "content-disposition",
            "content-security-policy",
            "cache-control",
            "cross-origin-resource-policy",
            "accept-ranges",
        ] {
            assert!(whole.headers().contains_key(name), "{name} on {url}");
            assert_eq!(
                part.headers().get(name),
                whole.headers().get(name),
                "{name} on {url}"
            );
        }
    }

    let part = fetch(&video_url, Some("bytes=10-19")).await;
    assert_eq!(part.headers()["content-type"], "video/mp4");
    assert_eq!(part.headers()["x-content-type-options"], "nosniff");
    assert!(part.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("inline;"));
    assert_eq!(
        part.headers()["content-security-policy"],
        "default-src 'none'; sandbox"
    );
    assert_eq!(
        part.headers()["cache-control"],
        "public, max-age=31536000, immutable"
    );

    let part = fetch(&download_url, Some("bytes=10-19")).await;
    assert_eq!(part.headers()["content-type"], "application/octet-stream");
    assert!(part.headers()["content-disposition"]
        .to_str()
        .unwrap()
        .starts_with("attachment;"));
}

#[tokio::test]
async fn a_range_past_the_end_is_refused_with_the_real_length() {
    let (_server, _host, url, _) = server_with_video().await;
    for range in [
        "bytes=100000-",
        "bytes=100000-100010",
        "bytes=250000-",
        // Zero bytes from the end is no bytes at all.
        "bytes=-0",
    ] {
        let refused = fetch(&url, Some(range)).await;
        assert_eq!(refused.status(), 416, "{range}");
        assert_eq!(
            refused.headers()["content-range"],
            format!("bytes */{VIDEO_LEN}"),
            "{range}"
        );
        assert_eq!(refused.headers()["accept-ranges"], "bytes", "{range}");
        assert_eq!(refused.headers()["x-content-type-options"], "nosniff");
        // An empty answer must never be cached as the file.
        assert_eq!(refused.headers()["cache-control"], "no-store", "{range}");
        assert!(refused.bytes().await.unwrap().is_empty(), "{range}");
    }
}

#[tokio::test]
async fn anything_but_one_plain_range_gets_the_whole_file() {
    let (_server, _host, url, video) = server_with_video().await;
    for range in [
        // Several ranges would need a multipart body no player asks for.
        "bytes=0-1,5-6",
        "bytes=0-99, 200-299",
        // Backwards, empty, not numbers, not bytes, no unit.
        "bytes=5-2",
        "bytes=",
        "bytes=-",
        "bytes=abc",
        "bytes=10-abc",
        "items=0-5",
        "0-5",
    ] {
        let whole = fetch(&url, Some(range)).await;
        assert_eq!(whole.status(), 200, "{range}");
        assert!(whole.headers().get("content-range").is_none(), "{range}");
        assert_eq!(whole.headers()["accept-ranges"], "bytes", "{range}");
        assert_eq!(whole.bytes().await.unwrap(), video, "{range}");
    }

    // Two Range headers are two ranges.
    let twice = client()
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-9")
        .header(reqwest::header::RANGE, "bytes=20-29")
        .send()
        .await
        .unwrap();
    assert_eq!(twice.status(), 200);
    assert_eq!(twice.bytes().await.unwrap(), video);

    // A range that only holds if the file hasn't changed, checked against a
    // validator this server never gave out, can't be trusted to line up.
    let conditional = client()
        .get(&url)
        .header(reqwest::header::RANGE, "bytes=0-9")
        .header(reqwest::header::IF_RANGE, "\"some-etag\"")
        .send()
        .await
        .unwrap();
    assert_eq!(conditional.status(), 200);
    assert_eq!(conditional.bytes().await.unwrap(), video);
}

// ---------------------------------------------------------------------------
// The three T-501 acceptance criteria
// ---------------------------------------------------------------------------

/// The milestone check in miniature: cut a file into parts, kill the connection
/// partway through one of them, resume, complete.
///
/// Sixteen megabytes over three parts rather than the milestone's 400 MB video,
/// because 400 MB is the same loop fifty times and a test suite should not move
/// half a gigabyte to learn nothing new. The size arithmetic is pinned
/// separately in `storage::tests`, and the video pipeline in
/// `a_video_gets_a_poster_frame_and_a_duration`. A real 400 MB file over a real
/// network is a human check, and belongs at the end of M5.
#[tokio::test]
async fn a_killed_upload_resumes_and_completes() {
    use futures_util::stream;

    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    // Three parts: two full ones and a short tail.
    let bytes = filler((PART * 2 + 4096) as usize);
    let slot = slot(
        &server,
        &host.access_token,
        "trip.bin",
        bytes.len() as u64,
        "application/octet-stream",
    )
    .await;
    let parts = slot.parts.clone().expect("over 8 MB is a multipart upload");
    assert_eq!(parts.len(), 3);
    assert_eq!(slot.part_size_bytes, PART);

    let chunk = |n: usize| {
        let start = n * PART as usize;
        bytes[start..(start + PART as usize).min(bytes.len())].to_vec()
    };

    // Part 1 lands.
    let (status, etag1) = put_part(&server, &parts[0].url, chunk(0)).await;
    assert_eq!(status, 200);

    // Part 2 dies halfway through: the client sends a body it never finishes.
    let half = chunk(1)[..1024].to_vec();
    let dying = stream::iter(vec![
        Ok::<_, std::io::Error>(axum::body::Bytes::from(half)),
        Err(std::io::Error::other("connection went away")),
    ]);
    let killed = client()
        .put(absolute(&server, &parts[1].url))
        .body(reqwest::Body::wrap_stream(dying))
        .send()
        .await;
    assert!(
        killed.is_err() || killed.unwrap().status() != StatusCode::OK,
        "a half-sent part must not report success"
    );

    // Completing now has to fail — a file with a hole in it is not a file.
    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 422);
    assert_eq!(error_code(resp).await, "VALIDATION_FAILED");

    // Resume: send the parts that are missing. Part 1 is not sent again.
    let (status, etag2) = put_part(&server, &parts[1].url, chunk(1)).await;
    assert_eq!(status, 200);
    let (status, etag3) = put_part(&server, &parts[2].url, chunk(2)).await;
    assert_eq!(status, 200);

    let claimed = vec![
        CompletedPart {
            number: 1,
            etag: etag1.unwrap(),
        },
        CompletedPart {
            number: 2,
            etag: etag2.unwrap(),
        },
        CompletedPart {
            number: 3,
            etag: etag3.unwrap(),
        },
    ];
    let resp = finish(&server, &host.access_token, &slot, Some(claimed)).await;
    assert_eq!(
        resp.status(),
        200,
        "resumed upload should complete: {}",
        resp.text().await.unwrap()
    );
    let attachment: Attachment = resp.json().await.unwrap();
    assert_eq!(attachment.size_bytes, bytes.len() as u64);

    // Every byte, in the right order.
    let served = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();
    assert_eq!(served.as_ref(), bytes.as_slice());
}

/// SPEC §4.10: EXIF is stripped from every image, always, no toggle. A camera
/// photo carries the GPS coordinates of wherever it was taken.
#[tokio::test]
async fn exif_never_survives_an_upload() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    let original = jpeg_with_exif_gps();
    assert!(
        String::from_utf8_lossy(&original).contains(EXIF_MARKER),
        "the fixture has to actually carry EXIF, or this test proves nothing"
    );

    let attachment = upload(
        &server,
        &host.access_token,
        "beach.jpg",
        "image/jpeg",
        original,
    )
    .await;
    let stored = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap()
        .bytes()
        .await
        .unwrap();

    let text = String::from_utf8_lossy(&stored);
    assert!(!text.contains(EXIF_MARKER), "the GPS block came through");
    assert!(!text.contains("Exif"), "an EXIF segment came through");
    // Still a picture, and the same one.
    let decoded = image::load_from_memory(&stored).unwrap();
    assert_eq!((decoded.width(), decoded.height()), (24, 18));
    assert_eq!((attachment.width, attachment.height), (Some(24), Some(18)));
}

/// The type on the way in is a claim. The bytes are the fact.
#[tokio::test]
async fn a_file_that_lies_about_its_type_is_refused() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    let mut zip = b"PK\x03\x04".to_vec();
    zip.extend_from_slice(&filler(512));
    let slot = slot(
        &server,
        &host.access_token,
        "cat.png",
        zip.len() as u64,
        "image/png",
    )
    .await;
    let (status, _) = put_part(&server, &slot.url, zip).await;
    assert_eq!(
        status, 200,
        "the bytes arrive; the lie is caught at complete"
    );

    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 415);
    assert_eq!(error_code(resp).await, "UNSUPPORTED_MEDIA");

    // And the failed slot is spent: it cannot be retried into something else.
    let (status, _) = put_part(&server, &slot.url, png(4, 4)).await;
    assert_eq!(status, 409);
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

#[tokio::test]
async fn size_is_refused_at_the_slot_and_again_at_the_bytes() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;

    // Over the per-file limit: refused before a byte moves.
    let resp = ask_for_slot(
        &server,
        &host.access_token,
        "huge.mp4",
        501 * 1024 * 1024,
        "video/mp4",
    )
    .await;
    assert_eq!(resp.status(), 413);
    assert_eq!(error_code(resp).await, "FILE_TOO_LARGE");

    let resp = ask_for_slot(&server, &host.access_token, "nothing.txt", 0, "text/plain").await;
    assert_eq!(resp.status(), 422);

    // Declared small, sent big: the listener stops writing at the declared size.
    let too_much = slot(&server, &host.access_token, "notes.txt", 64, "text/plain").await;
    let (status, _) = put_part(&server, &too_much.url, filler(4096)).await;
    assert_eq!(status, 413);

    // Declared big, sent small: caught when the file is measured at complete.
    let too_little = slot(&server, &host.access_token, "notes.txt", 4096, "text/plain").await;
    let (status, _) = put_part(&server, &too_little.url, filler(64)).await;
    assert_eq!(status, 200);
    let resp = finish(&server, &host.access_token, &too_little, None).await;
    assert_eq!(resp.status(), 422);
}

#[tokio::test]
async fn a_kind_of_file_this_server_does_not_take() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    for mime in ["image/svg+xml", "text/html", "application/x-msdownload"] {
        let resp = ask_for_slot(&server, &host.access_token, "x", 128, mime).await;
        assert_eq!(resp.status(), 415, "{mime} should be refused");
        assert_eq!(error_code(resp).await, "UNSUPPORTED_MEDIA");
    }
}

#[tokio::test]
async fn a_full_server_says_so_before_the_bytes_arrive() {
    // The pool is an environment variable on a real server; the harness sets
    // the same field without touching the process environment.
    let server = spawn_tuned(|config| config.pool_bytes = 4096).await;
    let host = bootstrap_host(&server).await;

    let _fits = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        filler(3000),
    )
    .await;

    let resp = ask_for_slot(&server, &host.access_token, "more.txt", 3000, "text/plain").await;
    assert_eq!(resp.status(), 507);
    assert_eq!(error_code(resp).await, "QUOTA_EXCEEDED");
}

#[tokio::test]
async fn an_upload_link_cannot_be_forged_or_moved() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let slot = slot(&server, &host.access_token, "notes.txt", 64, "text/plain").await;

    let tampered = slot.url.replace("sig=", "sig=00");
    let (status, _) = put_part(&server, &tampered, filler(8)).await;
    assert_eq!(status, 403);

    // A signature is for one part of one upload; it does not travel.
    let moved = slot.url.replace("/1?", "/2?");
    let (status, _) = put_part(&server, &moved, filler(8)).await;
    assert_eq!(status, 403);

    let expired = slot.url.replace("exp=", "exp=1");
    let (status, _) = put_part(&server, &expired, filler(8)).await;
    assert_eq!(status, 403);
}

#[tokio::test]
async fn an_upload_belongs_to_the_person_who_made_it() {
    let (server, host, room) = server_with_room("general").await;
    let other = join_member(&server, &host.access_token, "jo").await;

    let slot = slot(&server, &host.access_token, "notes.txt", 16, "text/plain").await;
    let (status, _) = put_part(&server, &slot.url, filler(16)).await;
    assert_eq!(status, 200);

    // Somebody else cannot finish it, cancel it, or post it.
    let resp = finish(&server, &other.access_token, &slot, None).await;
    assert_eq!(resp.status(), 403);

    let resp = client()
        .delete(server.url(&format!("/uploads/{}", slot.upload_id)))
        .bearer_auth(&other.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);

    let attachment = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(attachment.status(), 200);
    let attachment: Attachment = attachment.json().await.unwrap();

    let resp = client()
        .post(server.url(&format!("/rooms/{}/messages", room.id)))
        .bearer_auth(&other.access_token)
        .json(&serde_json::json!({ "body": "look", "attachment_ids": [attachment.id] }))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 403);

    // And the owner cannot post the same file onto two messages.
    for expected in [200, 409] {
        let resp = client()
            .post(server.url(&format!("/rooms/{}/messages", room.id)))
            .bearer_auth(&host.access_token)
            .json(&serde_json::json!({ "body": "mine", "attachment_ids": [attachment.id] }))
            .send()
            .await
            .unwrap();
        assert_eq!(resp.status(), expected);
    }
}

#[tokio::test]
async fn cancelling_an_upload_takes_the_bytes_with_it() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let attachment = upload(
        &server,
        &host.access_token,
        "notes.txt",
        "text/plain",
        filler(32),
    )
    .await;
    assert_eq!(
        client()
            .get(absolute(&server, &attachment.url))
            .send()
            .await
            .unwrap()
            .status(),
        200
    );

    let resp = client()
        .delete(server.url(&format!("/uploads/{}", attachment.id)))
        .bearer_auth(&host.access_token)
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 204);

    let resp = client()
        .get(absolute(&server, &attachment.url))
        .send()
        .await
        .unwrap();
    assert_eq!(resp.status(), 404);
}

#[tokio::test]
async fn completing_twice_returns_the_same_attachment() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let slot = slot(&server, &host.access_token, "notes.txt", 16, "text/plain").await;
    put_part(&server, &slot.url, filler(16)).await;

    let first: Attachment = finish(&server, &host.access_token, &slot, None)
        .await
        .json()
        .await
        .unwrap();
    let resp = finish(&server, &host.access_token, &slot, None).await;
    assert_eq!(resp.status(), 200);
    let again: Attachment = resp.json().await.unwrap();
    assert_eq!(first.id, again.id);
}

#[tokio::test]
async fn a_part_that_does_not_match_its_etag_is_caught() {
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let slot = slot(&server, &host.access_token, "notes.txt", 16, "text/plain").await;
    put_part(&server, &slot.url, filler(16)).await;

    let lying = vec![CompletedPart {
        number: 1,
        etag: "00".repeat(32),
    }];
    let resp = finish(&server, &host.access_token, &slot, Some(lying)).await;
    assert_eq!(resp.status(), 422);
}

#[tokio::test]
async fn stored_objects_stay_inside_the_object_directory() {
    let server = spawn_server().await;
    for probe in [
        "/objects/../linger.db",
        "/objects/..%2Flinger.db",
        "/objects/ab/../../linger.db",
    ] {
        let resp = client()
            .get(format!("{}{probe}", server.base))
            .send()
            .await
            .unwrap();
        assert!(
            resp.status() == 404 || resp.status() == 400,
            "{probe} answered {}",
            resp.status()
        );
    }
}

/// Video work is optional: a server with no ffmpeg stores the file and simply
/// has no poster frame. Skipped when the toolchain isn't installed.
#[tokio::test]
async fn a_video_gets_a_poster_frame_and_a_duration() {
    let Some(sample) = sample_video() else {
        eprintln!("skipping: ffmpeg is not installed");
        return;
    };
    let server = spawn_server().await;
    let host = bootstrap_host(&server).await;
    let attachment = upload(&server, &host.access_token, "clip.mp4", "video/mp4", sample).await;

    assert_eq!(attachment.mime, "video/mp4");
    assert_eq!(
        (attachment.width, attachment.height),
        (Some(160), Some(120))
    );
    let duration = attachment.duration_ms.expect("ffprobe reports a duration");
    assert!((1500..2500).contains(&duration), "duration was {duration}");

    let poster = attachment.poster_url.expect("videos get a poster frame");
    let served = client()
        .get(absolute(&server, &poster))
        .send()
        .await
        .unwrap();
    assert_eq!(served.status(), 200);
    assert_eq!(served.headers()["content-type"], "image/jpeg");
    assert!(attachment.blurhash.is_some(), "the poster gives a blurhash");
}

/// Two seconds of ffmpeg's test pattern, or `None` if ffmpeg isn't here.
fn sample_video() -> Option<Vec<u8>> {
    let out = tempfile::Builder::new().suffix(".mp4").tempfile().ok()?;
    let path = out.into_temp_path();
    let status = std::process::Command::new("ffmpeg")
        .args([
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "testsrc=size=160x120:rate=15:duration=2",
            "-pix_fmt",
            "yuv420p",
        ])
        .arg(&path)
        .status()
        .ok()?;
    status.success().then(|| std::fs::read(&path).ok())?
}
