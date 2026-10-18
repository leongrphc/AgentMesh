# AgentMesh IDE — görev listesi ve devam notları

**Son güncelleme:** 18 Ekim 2026  
**Çalışma alanı:** `D:\WebGpt`  
**Dal:** `main`  
**Karar:** C — Hibrit (CLI/SDK + doğrudan API)  
**Durum:** Yerel orkestrasyon MVP'si ve çalışan Electron/React masaüstü kabuğu; görev yönetimi, ajan durumları, context/mesajlar ve canlı olaylar mevcut.

Bu dosya, yarın kaldığımız yerden devam etmek için tek kontrol listesidir. Mimari detaylar `docs/architecture.md`, protokol `docs/agent-protocol.md`, ilk kapsam `docs/mvp.md` içinde.

## Hedef ürün

Codex, OpenCode, Claude, Antigravity ve diğer API modellerini **tek IDE içinde** aynı proje üzerinde görevlendirmek; 3–4 veya daha fazla bağımsız ajanı paralel çalıştırmak; ajanlar arası mesaj ve yapılandırılmış ortak context paylaşmak. Bir ajan plan yaparken diğerleri farklı worktree'lerde kod yazabilsin, yönetici ajan değiştirilebilsin. Sağlayıcıların özel sohbet geçmişlerini birbirine kopyalamak yerine **görevler, kararlar, mesajlar, sonuçlar ve oturum kimlikleri** ortaklaştırılsın. CLI ile kullanılabilen servisler kendi desteklenen arayüzleri üzerinden bağlansın; API gerektirenler API anahtarıyla çalışsın.

## Tamamlanan görevler

### Çekirdek / saklama

- [x] TypeScript + Node.js proje iskeleti, demo, dokümantasyon, otomatik testler.
- [x] Sağlayıcıdan bağımsız proje, ajan, görev, durum, mesaj ve context sözleşmeleri.
- [x] Bağımlılık tabanlı scheduler ve bağımsız görevleri paralel çalıştırma.
- [x] Yapılandırılmış context ve ajanlar arası mesajları sonraki görevlere aktarma.
- [x] JSONL event journal ve olaylardan durumu yeniden oluşturma.
- [x] SQLite WAL journal; JSONL aktarımı, tek-yazıcı kilidi, transaction'lı event batch.
- [x] Hata, engellenme, yeniden deneme, bekleyen inceleme, kesilme ve iptal durumları.

### CLI ajanları / Git izolasyonu

- [x] Codex CLI ve OpenCode CLI adaptörleri; JSONL yanıt ayrıştırma, native session ID saklama ve resume argümanları.
- [x] `--execute` olmadan dry-run; konfigürasyonla proje/görev tanımı.
- [x] Görev başına ayrı Git branch/worktree ve `allowedPaths` için işlem sonrası değişiklik denetimi.
- [x] Değişen dosyalar için `pending_review`, SHA-256 digest, `--review` ve `--approve`.
- [x] Onaylı kodu ana daldan ayrı AgentMesh **entegrasyon branch/worktree'sine** merge etme.
- [x] Bağımlı görevin onaylı kodu görmesi, farklı digest ve merge conflict reddi.
- [x] JSONL stdout/stderr ve journal olaylarını canlı `subscribe()` abonelerine iletme; CLI'da `--stream`.
- [x] `AbortSignal`, `Ctrl+C`, kalıcı `cancelled`, geç gelen çıktının görev sonucunu tamamlamasını engelleme.
- [x] Başarısız/iptal edilmiş/engellenmiş görevi `--retry TASK` ile açıkça yeniden kuyruğa alma.
- [x] Mock ve yerel subprocess/Git worktree testleri; son başarılı doğrulama **21/21 test**, `npm run typecheck`, desktop build ve gerçek Electron smoke başarılı.

## Açık görevler — öncelik sırasıyla

### P0 — Yarın ilk ele alınacak işler

- [ ] **CORE-004 / İzin köprüsü:** Codex/OpenCode adaptörlerindeki desteklenen izin isteme biçimlerini araştır, yetkileri normalize eden bir `permission.requested` → kullanıcı kararı → sonuç protokolü tasarla. Otomatik yetki yükseltme olmasın. Araştırma ve protokol taslağı: [permissions.md](permissions.md). Çift yönlü transport uygulaması ve testler henüz açık.
- [x] **CORE-005 / Güvenli log:** Ham stdout/stderr filtreleme, çıktı sınırları ve ayrı görüntüleme/kayıt politikaları. [Gizlilik politikası](log-privacy.md); filtre bilinen sır ve e-posta biçimlerini tanır.
  - [x] Orkestratör canlı çıktı sınırında anahtar/token/e-posta maskeleme, görüntüleme (8192 karakter) ve kalıcı hata (2048 karakter) politikaları; sızıntı/kalıcılık testleri.
  - [x] Süreç okuyucusunda chunk sınırlarını aşan sırlar için tamponlama, JSONL satır/toplam byte sınırı ve flood testleri. Varsayılan satır 1 MiB, stdout/stderr toplamı 16 MiB; aşımda süreç durur. JSONL canlı, stderr süreç kapanışında filtrelenir. Ham sonuç olayları dahili kalır; mevcut filtre keyfi kişisel veriyi tanıma garantisi vermez.
  - [x] Sonuç özeti/context/mesajlar ve eski journal kayıtları için ayrı gizlilik politikası; `--diagnostics` ile serbest metin içermeyen, salt olay sayıları dışa aktarımı ve kaynak veriyi koruma testi.
- [x] **CORE-006 / Desktop iskeleti:** Electron main + sandbox preload / doğrulanan IPC + React/Vite renderer; nodeIntegration kapalı, contextIsolation açık; snapshot ve olay aboneliği için dar API, özel yerel protocol ve CSP. `npm run desktop`, `npm run desktop:smoke`.
- [x] **CORE-007 / İlk arayüz:** Config dosyasıyla proje seçimi, görev listesi/detayı, ajan durumu, canlı olay paneli. Başlat/iptal/yeniden kuyruğa al backend'e bağlı. Varsayılan kalıcı mock demo, gerçek CLI çalıştırma için uygulama içinde açık başlatma kararı.
- [ ] **CORE-008 / Gerçek CLI smoke testleri:** Kimliği doğrulanmış Codex ve OpenCode ile küçük, ayrı ve güvenli test reposunda uçtan uca çalışmayı onay ve maliyet sınırlarına dikkat ederek doğrula; session/resume ve izin davranışlarını kaydet. Bu testler **henüz yapılmadı**.

### P1 — IDE'nin kullanılabilir hale gelmesi

- [ ] **UI-001:** Dosya ağacı ve Monaco editör; seçili görev worktree'sini doğru göstermesi.
- [ ] **UI-002:** Terminal sekmeleri (PTY) ve süreç yaşam döngüsü.
- [ ] **UI-003:** Agent Center: provider, CLI/SDK/API bağlantısı, model/rol, bağlantı sağlığı ve giriş eksikliği.
- [ ] **UI-004:** Task Board: görev oluşturma, bağımlılık çizimi, paralellik limiti, durum, iptal, tekrar dene, geçmiş.
- [x] **UI-005:** Shared Context ve ajan mesajlarını kaynak görevleriyle görünür kılma; masaüstü sekmeleri.
- [ ] **UI-006:** Diff/test önizleme, SHA-256 onayı, merge conflict çözme/yeniden deneme ekranı.
  - [x] Gerçek task worktree diff/yeni dosya önizlemesi, izin ihlalleri, SHA-256 digest ve uygulama içinde açık onay; değiştirilmiş diff reddi için masaüstü servis entegrasyon testi.
  - [ ] Yapılandırılmış test raporları ve commit edilmiş merge conflict için tam diff/çözüm/yeniden deneme akışı. Mevcut ekran bu durumda CLI incelemesine yönlendirir; otomatik çözüm yapmaz.
- [ ] **CORE-009:** Ajan çalışırken gelen mesajların canlı teslimi, inbox cursor ve idempotency.
- [ ] **CORE-010:** İzinleri çalıştırma **öncesinde** zorlayabilecek süreç/OS sandbox politikası; `allowedPaths` şu an yalnızca çalıştırma sonrasında denetleniyor.
- [ ] **CORE-011:** Kalıcı, sürümlü context/karar yönetimi; çakışan kararlar için doğrulama ve ilgili context paketini seçme.
- [ ] **CORE-012:** Güvenli log saklama/retention, hata teşhisi, oturum sağlığı ve yeniden başlatma kurtarma senaryoları.

### P2 — Hibrit sağlayıcılar ve ileri orkestrasyon

- [ ] **ADAPTER-001:** Claude Agent SDK / API anahtarı tabanlı uyumlu entegrasyon; sağlayıcı kullanım koşullarını doğrula.
- [ ] **ADAPTER-002:** Antigravity'nin güncel, resmen desteklenen entegrasyon yolunu doğrula; uygunsa Python sidecar veya desteklenen bağlantı kur.
- [ ] **ADAPTER-003:** OpenAI/Anthropic/Google ve uyumlu modeller için doğrudan API adaptörleri ve kontrollü dosya/terminal tool-loop.
- [ ] **ADAPTER-004:** ACP üzerinden başka coding ajanlarını; MCP üzerinden ortak araçları bağlama.
- [ ] **ORCH-001:** Yönetici ajan atama/değiştirme, planı görev DAG'ına dönüştürme, kullanıcı denetimiyle yeniden planlama.
- [ ] **ORCH-002:** Bütçe/token/kota, rate-limit, timeout, eşzamanlılık, başarısızlık ve maliyet politikaları.
- [ ] **ORCH-003:** Ajan bazlı yetki profilleri, kimlik bilgilerini OS credential store'da saklama, gizli bilgileri context'ten uzak tutma.
- [ ] **RELEASE-001:** Windows paketleme, otomatik güncelleme, kurulum/dağıtım ve kabul testleri.

## Yarın başlarken

1. `D:\WebGpt` içinde `git status --short` ve `git log -5 --oneline` ile durumu kontrol et.
2. `npm install` (gerekiyorsa), ardından `npm run typecheck` ve `npm test` çalıştır.
3. **CORE-004** ile başla: önce gerçek CLI izin/olay protokolünü doğrula, güvenli backend sözleşmesi ve testlerini uygula.
4. Sonra **CORE-005** log filtrelemesini yap; bunlar oturduktan sonra Electron/React kabuğuna geç.
5. **Her tamamlanan geliştirmeyi ayrı Git commit'iyle kaydet.** Commit'ten önce ilgili testleri çalıştır; `docs/TASKS.md` kutularını güncelle. Kullanıcı istemedikçe otomatik push/deploy/ana dal dışı entegrasyon merge'i yapma.

### Faydalı komutlar

```powershell
cd D:\WebGpt
git status --short
npm run typecheck
npm test
npm run demo
npm run live -- --config agentmesh.config.example.json

# Gerçek çalışma için önce örnek ayarlardan kişisel agentmesh.config.json oluştur:
# npm run live -- --config agentmesh.config.json --execute --stream
# npm run live -- --config agentmesh.config.json --review
# npm run live -- --config agentmesh.config.json --approve TASK_ID --digest SHA256
# npm run live -- --config agentmesh.config.json --retry TASK_ID
```

`--execute` gerçek CLI çalıştırır; sağlayıcı hesabı/ücretlendirme ve dosya etkisi oluşabilir. Normal test ve demo mock ajanlarla çalışır. Onaylı görev kodları kullanıcı `main` dalına kendiliğinden alınmaz.

## Commit geçmişi (bu not oluşturulmadan önce)

| Commit | Kapsam |
| --- | --- |
| `01fd2ac` | İlk MVP çekirdeği / temel proje |
| `6220c50` | Digest ile insan onaylı entegrasyon akışı |
| `4a9563c` | Canlı olay akışı ve görev iptali |
| `a8503b2` | Açık `--retry` komutu |

## Bilinen sınırlar / tamamlandı sanılmaması gerekenler

- Grafik masaüstü kabuğu var; dosya editörü, terminal ve tam Task Board henüz yok.
- Codex/OpenCode CLI komutları ve sahte süreç akışları test edildi; gerçek ücretli/oturum açılmış model çalıştırması doğrulanmadı.
- OpenCode için OS seviyesinde izolasyon kanıtlanmadı; mevcut `allowedPaths` denetimi işlem sonrasındadır.
- CLI izin/araç onayı köprüsü, chunk güvenli tam log filtrelemesi, gerçek zamanlı *ajanlar arası* mesaj teslimi eksik.
- Git merge conflict otomatik çözülmüyor; korunmuş görev branch'i manuel inceleme gerektiriyor.
- Claude, Antigravity ve doğrudan API sağlayıcıları hedef kapsamda; henüz çalışan adaptörleri yok.
- Native provider sohbetleri tek bir birleşik konuşma geçmişi değildir; paylaşılan veri yapılandırılmış görev/context/mesaj kayıtlarıdır.
