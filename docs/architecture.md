# Mimari kararı — Hibrit Multi-Agent IDE

## Hedef

Bir proje için birden fazla bağımsız ajanı (Codex, OpenCode, Claude, Antigravity veya doğrudan API modeli) çalıştırmak. Kullanıcı, ajan rolünü ve bağlantı yöntemini seçebilir: CLI / SDK / API. Ajanlar görevler, ortak proje hafızası ve mesaj kuyruğu üzerinden birlikte çalışır. Yönetici rolü değiştirilebilir; **orkestratör kendisi deterministik bir servistir**.

## Bileşenler

```text
Electron Desktop (React + Monaco + xterm.js)
                |
           IPC / local API
                v
      Orchestrator (Node/TypeScript)
       |            |           |
       |            |           +-- Event log / görev kartları
       |            +-------------- Shared Context / mesaj kutusu
       +--------------------------- Worktree + onay + merge kuyruğu
                |
       AdapterRegistry (capability discovery)
        |           |             |             |
    Codex SDK  OpenCode SDK  Claude Agent SDK  Python sidecar
        |           |             |             |
       CLI      CLI/server   API anahtarı     Antigravity SDK
                              (izinlere göre)   (API anahtarı)

       Direct model API provider'ları da ayrı adapter olabilir.
```

**MVP uygulama sırası:** çekirdek, SQLite, worktree, Codex/OpenCode CLI adaptörleri, insan onaylı entegrasyon dalı, canlı CLI olay aboneliği ve iptal eklendi. Electron/React kabuğu, dar preload/IPC, Monaco dosya editörü, Task Board ve diff onayı da çalışır. Sırada etkileşimli izin köprüsü, terminal ve sağlayıcı sağlığı; daha sonra Claude / Antigravity ile doğrudan API sağlayıcıları var. Adaptör sınırları sağlayıcı sürümlerinden bağımsız tutulur.

## Neden Electron?

Windows'ta Codex/OpenCode CLI süreçlerini çalıştırmak, PTY sunmak, Node SDK'larını kullanmak ve Monaco editörü sunmak doğal bir eşleşme. Electron main process arka plan servisinden ayrılır; renderer'a doğrudan shell veya API anahtarı erişimi verilmez. Tauri gelecekte alternatif olarak değerlendirilebilir.

## Gerçek "ortak context" nasıl olur?

Her sağlayıcının özel konuşma geçmişini birleştirmeye çalışmayacağız. Bunun yerine üç ayrı kayıt türü var:

1. **Kanıtlanabilir gerçekler:** API sözleşmesi, dosya yolu, test sonucu, alınan karar (anahtar + değer + kaynak görev + zaman).
2. **Mesajlar:** gönderen, hedef ajan, görev, mesaj türü ve ilişki kimliği.
3. **Ajan oturumları:** sağlayıcıya özel session/thread ID'leri. Ajanın native konuşma geçmişi kendi sağlayıcısında kalır.

Her ajan çağrısından önce Orchestrator bir **context paketi** oluşturur: proje yönergeleri, ilgili gerçekler, önceki görev sonuçları, kendisine gelen mesajlar, dosya durum özeti. Paket boyutu sınırlanmalı ve yalnızca ilgili anahtarlar aktarılmalıdır. Güncelleme çakışmalarında tek bir “son yazan kazanır” davranışı yeterli olmaz; mimari/API kararlarına sürüm ve inceleme kuralı eklenir.

## İş yürütme ve Git izolasyonu

- Her görev bir proje ve belirli bir ajanla ilişkilidir; `dependsOn` başka görevlerin bitmesini şart koşar.
- Bağımsız görevler aynı anda çalışır. Aynı dosyalara yazacak görevler **ayrı Git worktree** içinde tutulur; paralellik sadece izin verilen dosya/branch sınırları içinde açılır.
- Dosya değiştiren görevler `pending_review` olur. SHA-256 digest ile onaylanan değişiklik görev branch'inde commit edilir ve **AgentMesh entegrasyon worktree'sine** merge edilir. Bağımlı görevler yeni kodu buradan alır. Ana dal değiştirilmez; çakışma otomatik çözülmez.
- Değişiklikler özet, diff, test ve review aşamasından geçmeden ana dalda birleştirilmez.
- Ajanın komut çalıştırma / ağ / dosya erişim izinleri adapter kapasitelerine göre tanımlanır. Riskli dış etkiler için kullanıcı onayı gerekir.
- Çöken veya kesilen görev doğrudan tekrar yürütülmez. `needs_review` durumuna alınır; kullanıcı veya yönetici ajan çalışma ağacını inceleyip yeniden dener.
- Başarısız görev bağımlıları `blocked` durumuna alınır.

## Veri modeli — hedef

MVP çekirdeğinde **SQLite WAL** tek-yazıcı olay günlüğü ve JSONL'den ilk veri aktarımı var. Şu an olay replay'iyle state kuruluyor; aşağıdaki ilişkisel tablolar ileri sürüm hedefidir:

| Tablo | İşlev |
| --- | --- |
| `projects` | Workspace kökü, repo, proje ayarları |
| `agents` | Ajan örneği, sağlayıcı, bağlantı yöntemi, yetenekler |
| `sessions` | Proje/ajan/sağlayıcı oturum eşleşmesi |
| `tasks` | ID, rol, bağımlılıklar, durum, iş ağacı, izinler |
| `task_events` | Zaman damgalı izlenebilir olaylar |
| `messages` | Ajanlar arası posta kutusu, teslim/okundu işaretleri |
| `facts` | Context girdileri, kaynak, sürüm, kapsam |
| `artifacts` | Diff, test raporu, plan dosyası, çıktı |
| `approvals` | Komut/diff/merge izin istekleri ve kararlar |

API anahtarları SQLite içine düz metin koyulmaz; masaüstü işletim sistemi credential store'unda tutulur. Prompt / log içindeki sırlar ayrıca filtrelenir.

## Hibrit sağlayıcı kararı

| Sağlayıcı | Gerçek entegrasyon yolu | Kritik not |
| --- | --- | --- |
| Codex | `exec --json` veya `app-server` stdio JSON-RPC (uygulandı); SDK ileride alternatif | App Server thread/turn ve tek isteklik komut/dosya onayı sağlar. Native oturum ID ayrı saklanır; kimlik doğrulama sağlayıcı ayarlarına bağlıdır. |
| OpenCode | `@opencode-ai/sdk`, `opencode serve`, gerektiğinde ACP | Server `127.0.0.1` üzerinde açılır, auth/sürüm kontrolü ve proje dizini eşleştirmesi gerekir. |
| Claude | Claude Agent SDK / doğrudan Claude API | **Üçüncü taraf ürünlerde claude.ai giriş/abonelik kullanımına Anthropic'in önceden onay verilmedikçe izin vermediği belgeleniyor.** Uyumlu API anahtarı bağlantısı varsayılandır. |
| Antigravity | Python `google-antigravity` SDK için yerel sidecar | SDK Python tabanlıdır; Gemini API anahtarı veya desteklenen kurumsal kimlik doğrulaması gerekir. |
| Diğerleri | Resmî API SDK'sı veya ACP adaptörü | Model konuşması tek başına dosya/terminal kullanan kod ajanı değildir; gereken tool-loop'u adaptör sağlamalıdır. |

**ACP** editör–ajan iletişiminde standartlaştırılabilen işlemler için kullanılır. **MCP** ajanlara ortak araçlar (context sorgulama, mesaj gönderme, görev durumu, dosya sorgulama) sunmak için kullanılabilir. **Bizim dahili event protokolümüz** ise görevler ve ajanlar arası orkestrasyon içindir. Üçü birbirinin yerine geçmez.

## Proje ilerledikçe klasörleme

```text
apps/
  desktop/             # Electron main/preload + React renderer
  daemon/              # Yerel HTTP/IPC servis
packages/
  core/                # Orchestrator, scheduler, journal
  protocol/            # Validasyonlu dahili sözleşmeler
  adapters/            # Codex, OpenCode, Claude, Antigravity, API
  workspaces/          # Git worktree + diff + merge
  storage/             # SQLite ve migration'lar
  shared-context/      # Paketleme, seçme, kaynak, arama
```

Bu bir **hedef yapı**dır; şu an `src/core`, `src/adapters`, `src/desktop` ve `desktop` (renderer) altında geliştirme sürer. `scripts/build-desktop.mjs` main/preload için esbuild, renderer için Vite kullanır. Üretim renderer'ı özel yerel protokol üzerinden yüklenir; Node erişimi yoktur. Main süreç IPC kaynağı ve argümanlarını doğrular. Görev/paralellik ayarları journal'dan replay edilir; UI olay paneli son 200 olayı tutar. Terminal henüz bağlanmadı.

## Referanslar (18 Ekim 2026 itibarıyla)

- Codex SDK: https://github.com/openai/codex/blob/main/sdk/typescript/README.md
- OpenCode SDK: https://docs.opencode.ai/docs/sdk/
- OpenCode server: https://docs.opencode.ai/docs/server/
- Claude Agent SDK: https://code.claude.com/docs/en/agent-sdk/overview
- Antigravity Python SDK: https://www.antigravity.google/docs/sdk/overview
- ACP TypeScript: https://agentclientprotocol.com/libraries/typescript
