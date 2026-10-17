# Ajanlar arası iletişim ve görev protokolü — v0

Bu belge, uygulamanın **dahili** sözleşmesini tarif eder. Sağlayıcıların ACP / MCP / SDK protokollerine dönüştürme adapter katmanında yapılır.

## Akış

```text
Kullanıcı: "Auth geliştir"
  -> manager/planlayıcı planı ve bağımlılıkları önerir
  -> deterministic orchestrator görevleri doğrular ve kaydeder
  -> mimar görevi tamamlar ve `auth.contract` gerçeğini yayınlar
  -> backend ve frontend birbirinden bağımsız çalışır
  -> sonuçlar, mesajlar ve dosya değişiklikleri saklanır
  -> reviewer iki sonuca erişir, test/diff raporu inceler
  -> kullanıcıya birleştirme kararı sunulur
```

## Görev örneği

```json
{
  "id": "TASK-102",
  "projectId": "shop",
  "title": "Giriş formu",
  "instruction": "Onaylanmış API sözleşmesine göre giriş arayüzünü geliştir",
  "agentId": "opencode-frontend",
  "dependsOn": ["TASK-100"],
  "allowedPaths": ["src/components/auth/**"]
}
```

`allowedPaths` iş sonunda worktree değişikliklerine karşı doğrulanır; işletim sistemi düzeyinde erişim engeli değildir. Ajan kimliği bir sağlayıcı türü değil, proje içinde kullanıcının seçtiği **instance** kimliğidir (`codex-reviewer-1` gibi).

## Mesaj örneği

```json
{
  "id": "MSG-203",
  "projectId": "shop",
  "taskId": "TASK-101",
  "from": "claude-backend",
  "to": "opencode-frontend",
  "kind": "handoff",
  "body": "POST /api/login {email,password} -> {token} hazır.",
  "createdAt": "2026-10-18T00:00:00.000Z"
}
```

Mesaj türleri başlangıçta `handoff`, `question`, `progress`. Hedef `*` proje genelindeki ajanlara yayın demektir. Üretim sürümünde `correlationId`, `replyTo`, `acknowledgedAt`, `deliveredAt` ve idempotency anahtarları eklenir. Mesajlar aynı proje sınırını aşamaz.

## Context kaydı

```json
{
  "key": "auth.contract",
  "value": "POST /api/login -> {token:string}",
  "sourceTaskId": "TASK-100",
  "updatedAt": "2026-10-18T00:00:00.000Z"
}
```

Context sadece özet sohbet değildir. Her kararın **kaynak görevi** bulunur. Ajanın kendi sesyonunu başka ajanla paylaşmak yerine görev başlatıldığında ilgili context paketi eklenir. Sistem sırları (`.env`, anahtarlar) context'e girmemelidir.

## Olaylar

Orkestratör journal'ındaki temel olaylar: `project.created`, `task.created`, `task.started`, `task.review.requested`, `task.review.approved`, `task.completed`, `task.failed`, `task.blocked`, `task.interrupted`, `task.cancelled`, `task.retried`, `context.updated`, `message.sent`.

Örnek olay:

```json
{
  "id": "unique-event-id",
  "at": "2026-10-18T00:00:00.000Z",
  "payload": {
    "type": "task.completed",
    "projectId": "shop",
    "taskId": "TASK-101",
    "summary": "Login API ve testleri hazır"
  }
}
```

**MVP semantiği:** tek-yazıcı SQLite WAL ve eski JSONL kayıtlarını içe aktarma; sonuç, mesaj ve summary olayları transaction içinde birlikte kaydedilir. Dosya değiştiren görev `pending_review` durumuna geçer; sonuç ve context olayları sadece aynı digest'in insan tarafından onaylanmasının ardından yayınlanır. Yeni işler entegrasyon dalındaki onaylanmış koddan başlar. Çalışma **sırasında** ajan JSONL stdout/stderr olayları geçici `subscribe()` abonelerine iletilir, ancak ajanlar arası canlı mesaj yönlendirme henüz yoktur; mesajlar bir sonraki görev/turn'da aktarılır. `cancelTask()` / `AbortSignal` aktif CLI sürecini durdurur ve `cancelled` olayı kalıcıdır; kısmi dosyalar inceleme için korunur. Kaydedilen olaylar uygulama kapanıp açılsa da korunur. Çöken çalışma `needs_review` durumuna geçer.

**Üretim semantiği (sonraki faz):** şema sürümleme, teslim alındı işaretleri, gerçek zamanlı event subscription, backpressure, hata tekrar deneme limitleri, per-agent inbox cursor, onay bekleyen araç çağrıları ve correlation trace.

## Doğrulama ilkeleri

- Proje ID'si var olmalı, görev ID'si benzersiz olmalı, bağımlılıklar aynı projeden olmalı.
- Görevler bağımlılık tamamlanmadan başlamamalı; başarısız bağımlı görevleri bekletmeli.
- Kullanıcı veya yönetici tarafından alınan görev kararı JSON şemasına göre doğrulanmalı.
- Her proje kendi görev, hafıza ve mesaj kapsamına sahip olmalı.
- Adaptör hata verirse görev `failed`, buna bağımlı görevler `blocked` olmalı.
- Kod veya komut çalıştıran gerçek adaptörlerde izin ve worktree izolasyonu zorunlu olmalı.
