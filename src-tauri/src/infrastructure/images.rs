use std::io::Read;
use std::path::Path;

use base64::{engine::general_purpose::STANDARD, Engine as _};

use crate::error::{AppError, AppResult};

pub const MAX_IMAGE_BYTES: u64 = 25 * 1024 * 1024;

pub fn image_data_url(path: &Path) -> AppResult<String> {
    let mime = image_mime_type(path).ok_or_else(|| {
        AppError::Validation(format!(
            "Unsupported image type for preview: {}",
            path.display()
        ))
    })?;
    let file = std::fs::File::open(path)?;
    let mut bytes = Vec::new();
    file.take(MAX_IMAGE_BYTES + 1).read_to_end(&mut bytes)?;
    if (bytes.len() as u64) > MAX_IMAGE_BYTES {
        return Err(AppError::Validation(format!(
            "Image exceeds the 25 MiB preview limit: {}",
            path.display()
        )));
    }
    let encoded = STANDARD.encode(bytes);
    Ok(format!("data:{mime};base64,{encoded}"))
}

pub fn image_mime_type(path: &Path) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    match extension.as_str() {
        "png" => Some("image/png"),
        "svg" => Some("image/svg+xml"),
        "ico" => Some("image/x-icon"),
        "icns" => Some("image/icns"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::{image_data_url, image_mime_type, MAX_IMAGE_BYTES};
    use crate::error::AppError;

    #[test]
    fn mime_type_is_detected_from_known_icon_extensions() {
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/favicon.png")),
            Some("image/png")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/favicon.ico")),
            Some("image/x-icon")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/icon.svg")),
            Some("image/svg+xml")
        );
        assert_eq!(
            image_mime_type(std::path::Path::new("/tmp/preview.gif")),
            Some("image/gif")
        );
    }

    #[test]
    fn icon_data_url_embeds_the_file_as_base64() {
        let temp_dir = std::env::temp_dir().join(format!(
            "skein-icon-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp directory should exist");
        let icon_path = temp_dir.join("favicon.png");
        std::fs::write(&icon_path, [0u8, 1u8, 2u8, 3u8]).expect("icon bytes should be written");

        let data_url = image_data_url(&icon_path).expect("data url should be generated");
        assert!(data_url.starts_with("data:image/png;base64,"));

        let _ = std::fs::remove_file(icon_path);
        let _ = std::fs::remove_dir_all(temp_dir);
    }

    #[test]
    fn image_data_url_rejects_files_that_exceed_the_preview_limit() {
        let temp_dir = std::env::temp_dir().join(format!(
            "skein-image-limit-{}",
            chrono::Utc::now().timestamp_nanos_opt().unwrap_or_default()
        ));
        std::fs::create_dir_all(&temp_dir).expect("temp directory should exist");
        let icon_path = temp_dir.join("huge.png");
        std::fs::write(&icon_path, vec![0u8; (MAX_IMAGE_BYTES as usize) + 1])
            .expect("icon bytes should be written");

        let error = image_data_url(&icon_path).expect_err("oversized images should fail");
        assert!(matches!(error, AppError::Validation(_)));

        let _ = std::fs::remove_file(icon_path);
        let _ = std::fs::remove_dir_all(temp_dir);
    }
}
