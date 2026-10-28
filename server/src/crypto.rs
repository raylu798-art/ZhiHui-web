use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use argon2::{
    password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString},
    Argon2,
};
use base64::{engine::general_purpose::STANDARD, Engine};
use rand::{rngs::OsRng, RngCore};
use sha2::{Digest, Sha256};
use std::{fs::OpenOptions, io::Write, path::Path};

pub fn token() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    hex::encode(bytes)
}
pub fn hash_token(token: &str) -> String {
    hex::encode(Sha256::digest(token.as_bytes()))
}
pub fn hash_password(password: &str) -> anyhow::Result<String> {
    let salt = SaltString::generate(&mut OsRng);
    Argon2::default()
        .hash_password(password.as_bytes(), &salt)
        .map(|h| h.to_string())
        .map_err(|_| anyhow::anyhow!("password hash failed"))
}
pub fn verify_password(password: &str, hash: &str) -> bool {
    PasswordHash::new(hash).ok().is_some_and(|h| {
        Argon2::default()
            .verify_password(password.as_bytes(), &h)
            .is_ok()
    })
}
pub fn init_key(path: &Path) -> anyhow::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path)?;
    let mut key = [0; 32];
    OsRng.fill_bytes(&mut key);
    file.write_all(STANDARD.encode(key).as_bytes())?;
    file.sync_all()?;
    Ok(())
}
pub fn load_key(path: &Path) -> anyhow::Result<[u8; 32]> {
    let data = std::fs::read(path)?;
    let bytes = if data.len() == 32 {
        data
    } else {
        STANDARD.decode(std::str::from_utf8(&data)?.trim())?
    };
    bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("master key must contain 32 random bytes or base64 encoding"))
}
pub fn encrypt(key: &[u8; 32], context: &str, plaintext: &str) -> anyhow::Result<String> {
    let cipher = Aes256Gcm::new_from_slice(key).unwrap();
    let mut nonce = [0; 12];
    OsRng.fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            Nonce::from_slice(&nonce),
            Payload {
                msg: plaintext.as_bytes(),
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("encryption failed"))?;
    Ok(STANDARD.encode([nonce.to_vec(), ciphertext].concat()))
}
pub fn decrypt(key: &[u8; 32], context: &str, encrypted: &str) -> anyhow::Result<String> {
    let bytes = STANDARD.decode(encrypted)?;
    anyhow::ensure!(bytes.len() > 28, "invalid encrypted credential");
    let value = Aes256Gcm::new_from_slice(key)
        .unwrap()
        .decrypt(
            Nonce::from_slice(&bytes[..12]),
            Payload {
                msg: &bytes[12..],
                aad: context.as_bytes(),
            },
        )
        .map_err(|_| anyhow::anyhow!("invalid key or credential context"))?;
    Ok(String::from_utf8(value)?)
}
