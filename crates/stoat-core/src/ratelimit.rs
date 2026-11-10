//! Учёт rate-limit по бакетам, как их описывает Stoat.
//!
//! Stoat отдаёт заголовки `X-RateLimit-Bucket`, `X-RateLimit-Limit`,
//! `X-RateLimit-Remaining` и `X-RateLimit-Reset-After`, а при 429 — `Retry-After`.
//! Мы храним состояние по имени бакета и ждём перед следующим запросом,
//! вместо того чтобы ловить 429 и ретраить наугад.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use tokio::sync::Mutex;

/// Состояние одного бакета.
#[derive(Debug, Clone, Copy)]
pub struct Bucket {
    /// Сколько запросов разрешено в окне
    pub limit: u32,
    /// Сколько осталось
    pub remaining: u32,
    /// Через сколько окно обнулится
    pub reset_after: Duration,
    /// Когда был получен ответ
    pub seen_at: std::time::Instant,
}

impl Bucket {
    /// Сколько ещё нужно подождать до следующего запроса в этом бакете.
    pub fn wait_time(&self) -> Duration {
        if self.remaining > 0 {
            return Duration::ZERO;
        }
        let elapsed = self.seen_at.elapsed();
        self.reset_after.saturating_sub(elapsed)
    }
}

/// Хранилище состояний бакетов (потокобезопасное и дешево клонируемое).
#[derive(Debug, Default, Clone)]
pub struct RateLimiter {
    buckets: Arc<Mutex<HashMap<String, Bucket>>>,
}

impl RateLimiter {
    /// Новый пустой лимитер.
    pub fn new() -> Self {
        Self::default()
    }

    /// Подождать, если в бакете закончились запросы.
    pub async fn acquire(&self, bucket: &str) {
        let wait = {
            let buckets = self.buckets.lock().await;
            buckets.get(bucket).map(Bucket::wait_time)
        };

        if let Some(wait) = wait.filter(|wait| !wait.is_zero()) {
            tracing::debug!(bucket, ?wait, "ждём rate-limit");
            tokio::time::sleep(wait).await;
        }
    }

    /// Обновить состояние бакета по заголовкам ответа.
    pub async fn update(&self, bucket: String, limit: u32, remaining: u32, reset_after: Duration) {
        let mut buckets = self.buckets.lock().await;
        buckets.insert(
            bucket,
            Bucket {
                limit,
                remaining,
                reset_after,
                seen_at: std::time::Instant::now(),
            },
        );
    }

    /// Зафиксировать 429: бакет заблокирован до `retry_after`.
    pub async fn penalize(&self, bucket: String, retry_after: Duration) {
        let mut buckets = self.buckets.lock().await;
        buckets.insert(
            bucket,
            Bucket {
                limit: 0,
                remaining: 0,
                reset_after: retry_after,
                seen_at: std::time::Instant::now(),
            },
        );
    }

    /// Текущее состояние бакета (для диагностики и UI).
    pub async fn snapshot(&self) -> HashMap<String, Bucket> {
        self.buckets.lock().await.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn fresh_bucket_does_not_block() {
        let limiter = RateLimiter::new();
        limiter.acquire("channels/messages").await;
    }

    #[tokio::test]
    async fn exhausted_bucket_waits_until_reset() {
        let limiter = RateLimiter::new();
        limiter
            .update("b".into(), 5, 0, Duration::from_millis(50))
            .await;

        let started = std::time::Instant::now();
        limiter.acquire("b").await;
        assert!(started.elapsed() >= Duration::from_millis(45));
    }

    #[tokio::test]
    async fn update_restores_capacity() {
        let limiter = RateLimiter::new();
        limiter
            .penalize("b".into(), Duration::from_millis(30))
            .await;
        limiter
            .update("b".into(), 10, 9, Duration::from_secs(1))
            .await;

        let started = std::time::Instant::now();
        limiter.acquire("b").await;
        assert!(started.elapsed() < Duration::from_millis(20));
    }
}
