# İlk MVP — somut teslim planı

## Ürün kararı

**C seçeneği: Hibrit.** Kullanıcı aynı proje içinde bir ajanı desteklenen CLI/SDK üzerinden, başka bir ajanı API anahtarıyla çalıştırabilir. Kullanıcı yönetici ajanı değiştirebilir. Teknik kontrol paneli, maliyet/izin/değişiklik görünürlüğü sistemin sorumluluğudur.

## Aşama 0 — Yapıldı (bu repo)

- [x] TypeScript/Node geliştirme ortamı ve proje belgeleri.
- [x] Sağlayıcıdan bağımsız görev, mesaj, context ve adapter türleri.
- [x] Bağımlılık kontrollü scheduler ve eşzamanlı görev grubu.
- [x] Kalıcı JSONL journal, yeniden açıldığında state reconstruction.
- [x] Başarısız görevler için `blocked`, kesilen görevler için `needs_review`.
- [x] Mock ajanlarla dört görevli demo ve otomatik testler.
- [x] Görev sonuçlarının ortak context'e otomatik aktarılması.

## Aşama 1 — Kullanılabilir yerel backend

- [x] SQLite WAL, JSONL'den aktarım, tek-yazıcı kilidi ve transaction'lı event batch.
- [x] Görev bazlı worktree/branch hazırlama, değiştirilmiş dosyaları ve izin desenlerini denetleme.
- [x] Codex CLI JSONL adaptörü (thread başlatma, ID saklama, resume komutu).
- [x] OpenCode CLI JSONL adaptörü (session başlatma, ID saklama, resume komutu).
- [x] Dry-run ve açık `--execute` kapısıyla çalışan komut satırı girişi.
- [x] SHA-256 diff incelemesi, kullanıcı digest onayı ve ayrı entegrasyon worktree'sine merge.
- [x] Onaylanan kodun bağımlı görevlerde görünmesi; değişen diff ve merge çakışmalarının reddi.
- [x] CLI stdout/stderr olaylarını canlı abonelere aktarma; `AbortSignal` / `Ctrl+C` iptali ve kalıcı `cancelled` durumu.
- [x] Hata/iptal sonrası görev için `--retry TASK` komutuyla açıkça yeniden kuyruğa alma.
- [x] CLI izin talepleri için etkileşimli onay köprüsü; Codex App Server ve OpenCode 1.19.x Server, masaüstü tek isteklik karar paneli. Desteklenen kapsamlar docs/permissions.md içinde.
  - [x] Codex App Server, kapsamlı izin kuyruğu, masaüstü karar paneli ve sahte süreç/gerçek Electron testleri.
  - [x] OpenCode Server izinleri, fake HTTP/SSE testleri ve gerçek yerel modelsiz session/policy/SSE smoke.
  - [ ] Gerçek hesaplı model/araç smoke doğrulaması (CORE-008).
- [x] Filtrelenmiş ve sınırlı CLI tanılama çıktısı; serbest metin içermeyen güvenli destek raporu, masaüstünde kalıcı olay geçmişi.
- [ ] Codex/OpenCode canlı model oturumlarının uçtan uca sınanması.
- [ ] Ajan bağlantı durumunu/eksik kimlik doğrulamayı gösterme; gerçek ajanın yazma izinleri.
- [x] İki sahte CLI ajanının ayrı worktree'lerde paralel çalışması ve değişiklik raporu.

## Aşama 2 — Masaüstü IDE

- [x] Electron + React temel uygulama; doğrulanan IPC, sandbox ve güvenli preload API.
- [x] Config ile proje seçimi, görev worktree dosya ağacı ve kapsam/digest kontrollü Monaco editör.
- [x] Görev worktree'sine bağlı dört PTY terminal sekmesi; boyutlandırma, geçici çıktı ve sahipli yardımcı süreç kapanışı.
- [ ] Agent Center (ajan seçme, role bağlama, bağlantı sağlığı).
  - [x] Config'teki ajanların model/rol/transport/yetenek görünümü; Codex modelsiz hesap kaydı kontrolü, OpenCode exec sürümü veya Server sağlayıcı bağlantı bildirimi.
  - [ ] UI'dan ajan ekleme/ayar düzenleme; gerçek model erişimi/kota ayrıca CORE-008.
- [x] Task Board (görev oluşturma, bağımlılık çizimi, kalıcı paralellik, durum, iptal/tekrar dene, son 200 olay).
- [x] Shared Context ve ajan mesajları için kaynak görevleri gösteren masaüstü görünümü; çalışma sırasında canlı ajan teslimi ayrıca CORE-009.
- [ ] Diff/test önizleme; onaylı merge.
  - [x] Diff/yeni dosya önizlemesi ve SHA-256 ile onaylı entegrasyon; insan düzenlemesinden sonra inceleme yenileme.
  - [ ] Yapılandırılmış test kanıtları ve merge conflict çözme ekranı.

## Aşama 3 — Hibrit genişleme

- [ ] Claude Agent SDK için izinli API anahtarı adaptörü.
- [x] Claude headless CLI harness / API anahtarı ve Antigravity resmî CLI için otomatik görev adaptörleri; ortak sonuç zarfı, session saklama, context/mesaj devri ve Git/SQLite zincir testi.
- [ ] Antigravity Python SDK için güvenli sidecar, anahtar/kurumsal auth.
  - [x] Resmî CLI mevcut olduğundan ilk bağlantı Python sidecar gerektirmeden yapıldı; SDK callback/policy alternatifi ileri aşama.
- [ ] Doğrudan API agent harness (OpenAI / Anthropic / Google / uyumlu API).
- [ ] Manuel ve yarı otonom görev oluşturma; yönetici ajan değişimi.
- [ ] Bütçe, hız limiti, model seçimi ve başarısızlık politikaları.
- [ ] ACP ve MCP üzerinden ek ajanlar / harici araçlar.

## MVP kabul senaryosu

Bir kullanıcı Windows'ta depoyu seçer. `Codex-manager`, `OpenCode-frontend` ve gerekirse aynı sağlayıcıdan ikinci bir instance ekler. Kullanıcı 4 görevi bağlılıklarıyla oluşturur. İki iş ayrı worktree'de paralel çalışır, mesajları ve ortak context kararlarını paylaşır. Görev izleri ve oturum ID'leri uygulama kapanıp açıldıktan sonra görünür. Kodun ana dala girişi için diff, test ve kullanıcı onayı sunulur. Kullanıcı API anahtarıyla Claude veya başka model eklediğinde mevcut görev protokolü değişmez.

## Gerçekçi sınırlamalar / karar noktaları

- Her sağlayıcının oturum ve abonelik sınırları farklı. Bir CLI'nin kurulu olması o sağlayıcının üçüncü taraf OAuth/login kullanımını otomatik izinli kılmaz.
- Claude Agent SDK belgelerinde üçüncü tarafların önceden onay olmadan `claude.ai` giriş/rate limitlerini sunamayacağı belirtiliyor. İlk uyumlu yol API anahtarıdır.
- `allowedPaths` işlem sonunda doğrulanıyor; OS seviyesinde dosya erişimi sınırı henüz yok. Merge çakışmalarında otomatik çözüm/rollback arayüzü de henüz yok.
- API ajanı için güvenli tool loop gerekir; yalın metin tam IDE ajanı anlamına gelmez.
- Model çıktıları ve 'görev tamamlandı' ifadeleri, test ve diff denetimini ikame etmez.

## İlk gerçek geliştirme kartı

**Sıradaki işler:** UI'dan ajan ayarları (UI-003), config uyumu (CORE-013) ve merge conflict ekranı (UI-006). Desktop shell, log filtrelemesi, dosya editörü, PTY terminalleri, Task Board ve Codex/OpenCode Server izin köprüleri tamamlandı. Gerçek hesaplı model/araç smoke testleri CORE-008 altında hâlâ açık. Entegrasyon dalının ana dala alınması ayrıca kullanıcı kararına bağlı kalır.
