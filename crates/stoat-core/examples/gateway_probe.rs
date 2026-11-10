//! Проверка gateway: `cargo run -p stoat-core --example gateway_probe`.
//!
//! Без `STOAT_TOKEN` подключается с заведомо неверным токеном — сервер обязан
//! ответить `Error: InvalidSession`, и это подтверждает, что весь путь
//! (connect → Authenticate → разбор пакетов) работает.
//! С настоящим токеном печатает первые события, включая `Ready`.

use std::time::Duration;

use stoat_core::Instance;
use stoat_core::gateway::{self, GatewayConfig, GatewayEvent};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let instance = Instance::official();
    let token = std::env::var("STOAT_TOKEN").unwrap_or_else(|_| "invalid-session-token".into());
    let real_token = std::env::var("STOAT_TOKEN").is_ok();

    let (_handle, mut events) = gateway::connect(
        instance.gateway_url(&[stoat_core::ReadyField::Users]),
        token,
        GatewayConfig {
            // без настоящего токена не переподключаемся: ждём только ответ
            auto_reconnect: real_token,
            ..GatewayConfig::default()
        },
    )
    .await?;

    let deadline = tokio::time::Instant::now() + Duration::from_secs(20);
    let mut seen = 0usize;

    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            println!("истекло время ожидания событий");
            break;
        }

        match tokio::time::timeout(remaining, events.recv()).await {
            Ok(Some(event)) => {
                match &event {
                    GatewayEvent::Authenticated => println!("← Authenticated"),
                    GatewayEvent::Ready(ready) => {
                        println!(
                            "← Ready: серверов {}, каналов {}, пользователей {}",
                            ready.servers.as_ref().map_or(0, Vec::len),
                            ready.channels.as_ref().map_or(0, Vec::len),
                            ready.users.as_ref().map_or(0, Vec::len),
                        );
                    }
                    GatewayEvent::Error(error) => println!("← Error: {}", error.message()),
                    GatewayEvent::Logout => println!("← Logout"),
                    GatewayEvent::Pong { data } => println!("← Pong {data}"),
                    other => println!("← {other:?}"),
                }

                seen += 1;
                let terminal = matches!(
                    event,
                    GatewayEvent::Error { .. } | GatewayEvent::Logout | GatewayEvent::Ready(_)
                );
                if terminal && !real_token {
                    break;
                }
                if seen >= 5 {
                    break;
                }
            }
            Ok(None) => {
                println!("поток событий закрыт");
                break;
            }
            Err(_) => {
                println!("истекло время ожидания событий");
                break;
            }
        }
    }

    if seen == 0 {
        eprintln!("не получено ни одного события — проверьте сеть");
    }
    Ok(())
}
