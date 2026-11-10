//! Проверка связи с инстансом: `cargo run -p stoat-core --example probe`.
//!
//! Делает только read-only запросы: `GET /` и (если задан `STOAT_TOKEN`) `GET /users/@me`.

use stoat_core::Instance;
use stoat_core::http::{HttpClient, Token};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut instance = Instance::official();
    if let Ok(api) = std::env::var("STOAT_API_URL") {
        let ws = std::env::var("STOAT_WS_URL").unwrap_or_else(|_| "wss://events.stoat.chat".into());
        instance = Instance::custom(api, ws)?;
    }

    let root = instance.discover().await?;
    println!("инстанс:      {}", instance.name);
    println!("версия API:   {:?}", root.stoat.as_deref().unwrap_or("?"));
    println!("gateway:      {:?}", root.ws.as_deref());
    println!("autumn (CDN): {:?}", root.autumn_url());
    println!("voice:        {}", root.voice_enabled());
    instance.apply_root(&root)?;
    println!(
        "gateway URL:  {}",
        instance.gateway_url(&[stoat_core::ReadyField::Users])
    );

    if let Ok(token) = std::env::var("STOAT_TOKEN") {
        let mut http = HttpClient::new(instance.api_url.clone());
        http.set_token(Some(Token::Session(token)));
        match http.fetch_self().await {
            Ok(me) => println!("пользователь: {}#{}", me.username, me.discriminator),
            Err(error) => println!("токен не принят: {error}"),
        }
    }

    Ok(())
}
