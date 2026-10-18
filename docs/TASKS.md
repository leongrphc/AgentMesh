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
- [x] Mock ve yerel subprocess/Git worktree testleri; son başarılı doğrulama **44/44 test**, `npm run typecheck`, desktop build, Electron/Monaco/PTY/izin paneli smoke ve modelsiz yerel OpenCode Server protokol smoke başarılı.

## Açık görevler — öncelik sırasıyla

### P0 — Öncelikli işler

- [x] **CORE-004 / İzin köprüsü:** Normalize izin protokolü, Codex App Server ve OpenCode 1.19.x Server, masaüstü tek isteklik karar paneli uygulandı. Otomatik yetki yükseltme yok. Kapsam ve doğrulama: [permissions.md](permissions.md). Gerçek model/araç smoke doğrulaması ayrıca CORE-008.
  - [x] Çalıştırma/proje/digest kapsamlı izin kuyruğu; tek kullanımlık karar, 120 saniye timeout, iptal/kopma/restart reddi, komut metni saklamayan audit olayları. Mevcut tek yönlü CLI'ler interaktif izin desteğini false bildirir.
  - [x] Codex çift yönlü App Server transport, masaüstü karar paneli ve süreç protokol testleri. Yanlış thread/turn, session grant, ek izin, iptal/kopma ve bozuk/büyük RPC mesajı reddi testleri; gerçek Electron demo izin reddi smoke testi.
  - [x] OpenCode 1.19.x için sahipli loopback HTTP sunucusu, rastgele Basic auth, sürüm/OpenAPI/dizin kontrolü, SSE, yalnızca once/reject, değişmiş/geri çekilmiş izin reddi ve oturum politikasını resume öncesi yeniden uygulama; sahte HTTP/SSE süreç testleri.
  - [x] `npm run smoke:opencode`: yerel 1.19.3 üzerinde auth/schema, geçici session create/read/policy update, SSE ve geçici session temizliği; model/prompt çağrısı yok. Native PATCH politikayı sona eklediği için son deny/ask bloğu doğrulanır.
  - [x] OpenCode Server config/masaüstü bağlantısı ve sağlayıcı sağlık kontrolü. Bağlı sağlayıcı bildirimi model erişimi veya auth token geçerliliği garantisi değildir; ham sağlayıcı bilgisi renderer'a aktarılmaz.
- [x] **CORE-005 / Güvenli log:** Ham stdout/stderr filtreleme, çıktı sınırları ve ayrı görüntüleme/kayıt politikaları. [Gizlilik politikası](log-privacy.md); filtre bilinen sır ve e-posta biçimlerini tanır.
  - [x] Orkestratör canlı çıktı sınırında anahtar/token/e-posta maskeleme, görüntüleme (8192 karakter) ve kalıcı hata (2048 karakter) politikaları; sızıntı/kalıcılık testleri.
  - [x] Süreç okuyucusunda chunk sınırlarını aşan sırlar için tamponlama, JSONL satır/toplam byte sınırı ve flood testleri. Varsayılan satır 1 MiB, stdout/stderr toplamı 16 MiB; aşımda süreç durur. JSONL canlı, stderr süreç kapanışında filtrelenir. Ham sonuç olayları dahili kalır; mevcut filtre keyfi kişisel veriyi tanıma garantisi vermez.
  - [x] Sonuç özeti/context/mesajlar ve eski journal kayıtları için ayrı gizlilik politikası; `--diagnostics` ile serbest metin içermeyen, salt olay sayıları dışa aktarımı ve kaynak veriyi koruma testi.
- [x] **CORE-006 / Desktop iskeleti:** Electron main + sandbox preload / doğrulanan IPC + React/Vite renderer; nodeIntegration kapalı, contextIsolation açık; snapshot ve olay aboneliği için dar API, özel yerel protocol ve CSP. `npm run desktop`, `npm run desktop:smoke`.
- [x] **CORE-007 / İlk arayüz:** Config dosyasıyla proje seçimi, görev listesi/detayı, ajan durumu, canlı olay paneli. Başlat/iptal/yeniden kuyruğa al backend'e bağlı. Varsayılan kalıcı mock demo, gerçek CLI çalıştırma için uygulama içinde açık başlatma kararı.
- [ ] **CORE-008 / Gerçek CLI smoke testleri:** Kimliği doğrulanmış Codex ve OpenCode ile küçük, ayrı ve güvenli test reposunda uçtan uca çalışmayı onay ve maliyet sınırlarına dikkat ederek doğrula; session/resume ve izin davranışlarını kaydet. Bu testler **henüz yapılmadı**.
  - [x] Modelsiz yerel bağlantı kontrolü: Codex 0.159.2 App Server initialize/account-read ve OpenCode 1.19.3 sürümü doğrulandı. Hesap kaydı kontrolü model erişimi veya kota testi değildir.
  - [x] OpenCode 1.19.3 gerçek yerel Server: auth/schema/dizin, session create/read/policy update, SSE ve sağlayıcı bağlantı bildirimi; hiçbir prompt veya generation gönderilmedi.

### P1 — IDE'nin kullanılabilir hale gelmesi

- [x] **UI-001:** Klasör bazlı dosya ağacı ve yerel Monaco editör; seçili görevin worktree'si, henüz worktree yoksa salt okunur proje kökü. Kaydetme yalnızca durdurulmuş görev worktree'sinde, allowedPaths ve içerik digest kontrolüyle. UTF-8/1 MiB sınırı, path traversal/symlink engeli, kaydedilmemiş değişiklik koruması ve gerçek Electron dosya açma smoke testi.
- [x] **UI-002:** xterm.js + node-pty ile en fazla dört görev terminali, boyutlandırma, çıktı/çıkış durumu ve açık kapatma. CWD main süreçte doğrulanan durdurulmuş worktree; demo kendi dizininde çalışır. Açık süreçler ajan başlatma/retry/onayını, tüm sekmeler proje değişimini engeller. Her PTY ayrı sahipli yardımcı süreçte; kapanış beklenir. 128 Ki karakter geçici çıktı tamponu, IPC geri basıncı, journal'a ham terminal çıktısı yazmama. Gerçek Node/Electron PTY, alt süreç kapanışı ve sınır testleri; [terminal kapsamı](terminals.md). Genel OS/ayrık süreç ağacı izolasyonu CORE-010 altında açık.
- [ ] **UI-003:** Agent Center: provider, CLI/SDK/API bağlantısı, model/rol, bağlantı sağlığı ve giriş eksikliği.
  - [x] Config'teki CLI ajanları için provider/transport/model/rol/izin yeteneği görünümü, açık bağlantı kontrolü, Codex hesap kaydı/giriş gerekliliği; OpenCode exec sürümü veya Server bağlı sağlayıcı bildirimi. Kontrol generation göndermez; sonuç kimlik/token içermez. Transport/model kombinasyonları ayrı kontrol edilir.
  - [ ] UI'dan ajan ekleme/model/rol ayarı ve SDK/API bağlantıları. Gerçek model erişimi/token geçerliliği CORE-008 altında doğrulanacak.
- [x] **UI-004:** Task Board: görev oluşturma, bağımlılık çizimi (100 göreve kadar SVG; büyük projelerde liste), kalıcı 1–8 paralellik limiti, durum, iptal, tekrar dene, son 200 olay ve seçili görev filtresi. Oluşturulan görevler/paralellik SQLite replay ile korunur; gerçek Electron form smoke testi eklendi.
- [x] **UI-005:** Shared Context ve ajan mesajlarını kaynak görevleriyle görünür kılma; masaüstü sekmeleri.
- [ ] **UI-006:** Diff/test önizleme, SHA-256 onayı, merge conflict çözme/yeniden deneme ekranı.
  - [x] Gerçek task worktree diff/yeni dosya önizlemesi, izin ihlalleri, SHA-256 digest ve uygulama içinde açık onay; değiştirilmiş diff reddi için masaüstü servis entegrasyon testi. İnsan düzenlemesi sonrası açık inceleme yenileme yeni digest'i kaydeder; eski onay geçersiz kalır.
  - [ ] Yapılandırılmış test raporları ve commit edilmiş merge conflict için tam diff/çözüm/yeniden deneme akışı. Mevcut ekran bu durumda CLI incelemesine yönlendirir; otomatik çözüm yapmaz.
- [ ] **CORE-009:** Ajan çalışırken gelen mesajların canlı teslimi, inbox cursor ve idempotency.
- [ ] **CORE-010:** İzinleri çalıştırma **öncesinde** zorlayabilecek süreç/OS sandbox politikası; `allowedPaths` şu an yalnızca çalıştırma sonrasında denetleniyor. Native sağlayıcı/araç alt süreç ağacının iptal ve kapanış garantileri ayrıca sınanmalı; sahipli ana sunucuyu kapatmak tek başına OS izolasyonu değildir.
- [ ] **CORE-011:** Kalıcı, sürümlü context/karar yönetimi; çakışan kararlar için doğrulama ve ilgili context paketini seçme.
- [ ] **CORE-012:** Güvenli log saklama/retention, hata teşhisi, oturum sağlığı ve yeniden başlatma kurtarma senaryoları.
- [ ] **CORE-013 / Config uyumu:** Yeniden açılan projede görev/ajan tanımları değişmişse sessizce eski tanımı kullanmak yerine farkı göster; eksik sağlayıcı eşlemesi ve aynı ID'nin farklı kapsam/talimatla kullanılması için açık güncelleme akışı.
- [ ] **UI-007 / Editör devamı:** Dosya/klasör oluşturma, disk değişikliği izleme, çoklu dosya sekmeleri ve kaydedilmemiş taslak kurtarma. Monaco paket boyutu/ilk yükleme optimizasyonu; şu anda editör ayrı ve tembel yüklenen yaklaşık 2.6 MB chunk.

### P2 — Hibrit sağlayıcılar ve ileri orkestrasyon

- [ ] **ADAPTER-001:** Claude Agent SDK / API anahtarı tabanlı uyumlu entegrasyon; sağlayıcı kullanım koşullarını doğrula.
- [ ] **ADAPTER-002:** Antigravity'nin güncel, resmen desteklenen entegrasyon yolunu doğrula; uygunsa Python sidecar veya desteklenen bağlantı kur.
- [ ] **ADAPTER-003:** OpenAI/Anthropic/Google ve uyumlu modeller için doğrudan API adaptörleri ve kontrollü dosya/terminal tool-loop.
- [ ] **ADAPTER-004:** ACP üzerinden başka coding ajanlarını; MCP üzerinden ortak araçları bağlama.
- [ ] **ORCH-001:** Yönetici ajan atama/değiştirme, planı görev DAG'ına dönüştürme, kullanıcı denetimiyle yeniden planlama.
- [ ] **ORCH-002:** Bütçe/token/kota, rate-limit, timeout, eşzamanlılık, başarısızlık ve maliyet politikaları.
- [ ] **ORCH-003:** Ajan bazlı yetki profilleri, kimlik bilgilerini OS credential store'da saklama, gizli bilgileri context'ten uzak tutma.
- [ ] **RELEASE-001:** Windows paketleme, otomatik güncelleme, kurulum/dağıtım ve kabul testleri.

## Devam ederken

1. `D:\WebGpt` içinde `git status --short` ve `git log -5 --oneline` ile durumu kontrol et.
2. `npm install` (gerekiyorsa), ardından `npm run typecheck` ve `npm test` çalıştır.
3. Codex App Server ve OpenCode Server köprüleri tamamlandı; [permissions.md](permissions.md) desteklenen kapsamları açıklar. Varsayılan exec adaptörleri interaktif izin desteklemez. Modelsiz yerel kontrol: `npm run smoke:opencode`.
4. Terminal (UI-002) tamamlandı. Sırada UI'dan ajan ayarları (UI-003), config uyumu (CORE-013) ve UI-006 çakışma çözümünün kalan kısmı var. Gerçek model/araç smoke'ları (CORE-008) hâlâ açık.
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

- Grafik masaüstü kabuğu, Monaco editör, Task Board ve görev PTY terminalleri var. Editör mevcut dosyaları düzenler; yeni dosya/klasör oluşturma ve dosya izleyicisi henüz yok.
- Codex/OpenCode CLI komutları ve sahte süreç akışları test edildi; gerçek ücretli/oturum açılmış model çalıştırması doğrulanmadı.
- OpenCode için OS seviyesinde izolasyon kanıtlanmadı; mevcut `allowedPaths` denetimi işlem sonrasındadır.
- Codex App Server ve OpenCode Server için araç onayı köprüleri var; gerçek zamanlı *ajanlar arası* mesaj teslimi eksik. OpenCode Server şu an 1.19.x v1 şemasına bağlıdır ve yalnızca bash/read/edit kapsamlarını sunar. Log filtresi bilinen biçimleri tanır; keyfi kişisel veri için garanti vermez.
- Git merge conflict otomatik çözülmüyor; korunmuş görev branch'i manuel inceleme gerektiriyor.
- Claude, Antigravity ve doğrudan API sağlayıcıları hedef kapsamda; henüz çalışan adaptörleri yok.
- Native provider sohbetleri tek bir birleşik konuşma geçmişi değildir; paylaşılan veri yapılandırılmış görev/context/mesaj kayıtlarıdır.
