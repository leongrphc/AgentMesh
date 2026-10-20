# AgentMesh IDE — görev listesi ve devam notları

**Son güncelleme:** 20 Ekim 2026

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
- [x] Mock ve yerel subprocess/Git worktree testleri; 20 Ekim doğrulaması **67/67 test**, `npm run typecheck` ve `npm run desktop:smoke` başarılı. Desktop smoke build, Electron/sandbox/preload, Monaco, gerçek PTY, ajan ayarları, test raporları, gerçek Git çakışmasını formdan çözme ve demo görevlerini kapsar. Native OpenCode TUI ve modelsiz yerel OpenCode Server protokol smoke önceki çalışmada doğrulandı.

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
  - [x] Windows normal açılışında `windowsHide` kapalı; yükleme sonrası açık `show/focus` ve açılış bildirimi. `npm run desktop:smoke:window` görünür pencereyi de doğrular. Smoke testleri üretim Electron profilini kullanmaz; paralel açık uygulamanın cache'iyle çakışmaz.
- [ ] **CORE-008 / Gerçek CLI smoke testleri:** Kimliği doğrulanmış Codex ve OpenCode ile küçük, ayrı ve güvenli test reposunda uçtan uca çalışmayı onay ve maliyet sınırlarına dikkat ederek doğrula; session/resume ve izin davranışlarını kaydet. Kod/araç/session-resume uçtan uca testleri **henüz yapılmadı**.
  - [x] Modelsiz yerel bağlantı kontrolü: Codex 0.159.2 App Server initialize/account-read ve OpenCode 1.19.3 sürümü doğrulandı. Hesap kaydı kontrolü model erişimi veya kota testi değildir.
  - [x] OpenCode 1.19.3 gerçek yerel Server: auth/schema/dizin, session create/read/policy update, SSE ve sağlayıcı bağlantı bildirimi; hiçbir prompt veya generation gönderilmedi.
  - [x] 18 Ekim gerçek mesaj testi: Codex App Server geçici salt okunur thread'de kısa selamlama isteğine **Selam!** yanıtı verdi (yaklaşık 5.5 sn). Native thread sandbox değeri `read-only`/`workspace-write` olarak düzeltildi; turn sandbox policy farklı olarak `readOnly`/`workspaceWrite` kullanır. OpenCode varsayılanı yerel `127.0.0.1:11434` model servisine bağlanamadı; ayrıca `opencode/big-pickle` HTTP 403 ile reddedildi. Bu ilk Server denemelerinde başarılı generation doğrulanmadı; sonraki native TUI sonucu aşağıdadır. Ayrıntılar: [provider-message.md](provider-message.md).
  - [x] Takip doğrulaması: **OpenCode Space Bunny Free / etkileşimli TUI**, `Selam` → **Merhaba! Nasıl yardımcı olabilirim?** (native ekranda yaklaşık 3.8 sn). Aynı model `opencode run --format json` ile 403 verdi. Çalışan native TUI, ajan merkezine PTY olarak eklendi; HTTP başlığı/istemci kimliği değiştirme yok. `npm run desktop:smoke:opencode-tui` gerçek Electron içinde native ekranı ve kapatmayı modelsiz doğrular.
  - [ ] Ücretsiz TUI modellerinin scheduler görevleriyle yapılandırılmış sonuç/izin/session-resume entegrasyonu. Native sohbetin çalışması mevcut exec/Server adaptörlerinin bu modellere eriştiği anlamına gelmez.

### P1 — IDE'nin kullanılabilir hale gelmesi

- [x] **UI-001:** Klasör bazlı dosya ağacı ve yerel Monaco editör; seçili görevin worktree'si, henüz worktree yoksa salt okunur proje kökü. Kaydetme yalnızca durdurulmuş görev worktree'sinde, allowedPaths ve içerik digest kontrolüyle. UTF-8/1 MiB sınırı, path traversal/symlink engeli, kaydedilmemiş değişiklik koruması ve gerçek Electron dosya açma smoke testi.
- [x] **UI-002:** xterm.js + node-pty ile en fazla dört görev terminali, boyutlandırma, çıktı/çıkış durumu ve açık kapatma. CWD main süreçte doğrulanan durdurulmuş worktree; demo kendi dizininde çalışır. Açık süreçler ajan başlatma/retry/onayını, tüm sekmeler proje değişimini engeller. Her PTY ayrı sahipli yardımcı süreçte; kapanış beklenir. 128 Ki karakter geçici çıktı tamponu, IPC geri basıncı, journal'a ham terminal çıktısı yazmama. Gerçek Node/Electron PTY, alt süreç kapanışı ve sınır testleri; [terminal kapsamı](terminals.md). Genel OS/ayrık süreç ağacı izolasyonu CORE-010 altında açık.
- [ ] **UI-003:** Agent Center: provider, CLI/SDK/API bağlantısı, model/rol, bağlantı sağlığı ve giriş eksikliği.
  - [x] OpenCode bağlantı seçimi: varsayılan etkileşimli terminal ve Space Bunny Free; alternatif CLI run/HTTP Server tek mesaj. Native terminal ayrı geçici dizinde açılır, pencere içinde genişler, kapatma/uygulama çıkışında süreç ve geçici dizin temizlenir. Normal kullanıcı yetkileri ve native izin ekranları açıkça belirtilir.
  - [x] Demo dahil ajan merkezinde gerçek tek mesaj testi: Codex/OpenCode, isteğe bağlı model, 2000 karakter mesaj, yanıt/süre/hata görünümü ve iptal. Projeden ayrı geçici dizin, Codex salt okunur ephemeral thread ve shell kapatma, OpenCode deny-all test session; 90 sn sınırı. Prompt/yanıt journal'a eklenmez. Test formu Electron smoke'unda doğrulanır; otomatik smoke gerçek generation göndermez.
  - [x] Config'teki CLI ajanları için provider/transport/model/rol/izin yeteneği görünümü, açık bağlantı kontrolü, Codex hesap kaydı/giriş gerekliliği; OpenCode exec sürümü veya Server bağlı sağlayıcı bildirimi. Kontrol generation göndermez; sonuç kimlik/token içermez. Transport/model kombinasyonları ayrı kontrol edilir.
  - [x] UI'dan ajan ekleme, provider/transport/model ve rol talimatı düzenleme. Ayarlar proje journal'ında kalıcı; CLI aynı ayarları okur. Rol otomatik görev istemine aktarılır. Çalışma geçmişi/session/worktree bulunan ajanın ayarı kilitlenir; farklı kimlikle yeni ajan eklenebilir. Kaynak JSON değiştirilmez. Demo mock olarak kalır.
  - [ ] SDK/API bağlantıları. Gerçek model erişimi/token geçerliliği CORE-008 altında doğrulanacak.
- [x] **UI-004:** Task Board: görev oluşturma, bağımlılık çizimi (100 göreve kadar SVG; büyük projelerde liste), kalıcı 1–8 paralellik limiti, durum, iptal, tekrar dene, son 200 olay ve seçili görev filtresi. Oluşturulan görevler/paralellik SQLite replay ile korunur; gerçek Electron form smoke testi eklendi.
- [x] **UI-005:** Shared Context ve ajan mesajlarını kaynak görevleriyle görünür kılma; masaüstü sekmeleri.
- [x] **UI-006:** Diff/test önizleme, SHA-256 onayı, merge conflict çözme/yeniden deneme ekranı.
  - [x] Gerçek task worktree diff/yeni dosya önizlemesi, izin ihlalleri, SHA-256 digest ve uygulama içinde açık onay; değiştirilmiş diff reddi için masaüstü servis entegrasyon testi. İnsan düzenlemesi sonrası açık inceleme yenileme yeni digest'i kaydeder; eski onay geçersiz kalır.
  - [x] Sonuç zarfında isteğe bağlı `tests`: başarılı/başarısız/çalıştırılmadı, komut ve açıklama; sınır ve şema kontrolü, tanılama maskelemesi. Görev detayı, diff inceleme ve CLI raporunda gösterilir; SQLite replay ile korunur. Bunlar ajan beyanıdır, bağımsız test yürütmesi değildir. Dosyalar değiştiğinde digest üzerinden eski rapor uyarısı gösterilir; incelemeyi yenilemek test raporunu güncellemez.
  - [x] Commit edilmiş değişiklikler görev başlangıç commit'ine göre incelenir; stage/commit boyunca içerik digest'i korunur. Merge çakışması kalıcı olaya kaydedilir. Çözüm görev worktree'sinde açılır; metin düzenleme, mevcut ikili dosyayı koruma veya açık silme sonrası yeniden diff/digest onayı gerekir. Çözüm sırasında yeniden açılış ve entegrasyon dalının ilerleyip ikinci çakışma üretmesi test edildi. Otomatik çözüm yok; 1 MiB/UTF-8 editör sınırı, symlink ve kapsam denetimi sürer. Büyük dosyalar/özel Git çatışmaları harici araçla çözülüp inceleme yenilenebilir. [Akış ve sınırlar](merge-review.md).
- [ ] **CORE-009:** Ajan çalışırken gelen mesajların canlı teslimi, inbox cursor ve idempotency.
- [ ] **CORE-010:** İzinleri çalıştırma **öncesinde** zorlayabilecek süreç/OS sandbox politikası; `allowedPaths` şu an yalnızca çalıştırma sonrasında denetleniyor. Native sağlayıcı/araç alt süreç ağacının iptal ve kapanış garantileri ayrıca sınanmalı; sahipli ana sunucuyu kapatmak tek başına OS izolasyonu değildir.
- [ ] **CORE-011:** Kalıcı, sürümlü context/karar yönetimi; çakışan kararlar için doğrulama ve ilgili context paketini seçme.
  - [x] Tüm otomatik adaptörlerde sürüm 1 sonuç zarfı: summary/facts/messages doğrulanır, alıcılar proje görev ajanlarıyla sınırlanır; boyut, tekrarlı anahtar ve ayrılmış system/task anahtarları denetlenir. Eski düz metin özetleri çalışır. Fact/mesaj kaynak kimlikleri modelden alınmaz; orkestratör atar. Sonuçlar diff onayından sonra transaction ile kaydedilir ve sonraki ajana aktarılır.
  - [ ] Karar revizyonları, çelişki çözümü ve görevle ilgili context paketini seçme.
- [ ] **CORE-012:** Güvenli log saklama/retention, hata teşhisi, oturum sağlığı ve yeniden başlatma kurtarma senaryoları.
- [ ] **CORE-013 / Config uyumu:** Kayıtlı görev ve ajan tanımlarını açık güncelleme akışıyla uzlaştırma.
  - [x] Desktop yeniden açma ve CLI execute öncesi toplu görev kontrolü: aynı ID'de başlık/talimat/ajan/bağımlılık/kapsam farkı alan adlarıyla reddedilir; ham talimat hata metnine alınmaz. UI görevleri korunur; eksik ajan eşlemesi ve başka projedeki görev ID çakışması yeni görev eklenmeden reddedilir. Dizi sırası anlamsız fark üretmez; tekrarlı bağımlılıklar config doğrulamasında reddedilir. Başarısız açılış eski projeyi/journal'ı kullanılabilir bırakır.
  - [x] Ajan tanımları `project.agents.configured` olayıyla kalıcı bağlandı; masaüstü ve CLI aynı çözümlemeyi kullanır. Kaynak config değişirse kayıtlı kaynak veya etkin ajan listesiyle eşleşmesi gerekir; uyumsuz değişiklik reddedilir. Kullanılmış ajan bağlantısı/rolü ve oturumlu pending retry değiştirilemez.
  - [ ] Farkları karşılaştıran güncelleme ekranı ve güvenli görev revizyonu. Şimdilik görev farkında orijinal tanımı geri yüklemek veya yeni görev kimliği kullanmak gerekir. Eski journal'ların ilk bağlaması mevcut config üzerinden yapılır; daha önce kaydedilmemiş provider/model geçmişi geriye dönük kanıtlanamaz.
- [ ] **UI-007 / Editör devamı:** Dosya/klasör oluşturma, disk değişikliği izleme, çoklu dosya sekmeleri ve kaydedilmemiş taslak kurtarma. Monaco paket boyutu/ilk yükleme optimizasyonu; şu anda editör ayrı ve tembel yüklenen yaklaşık 2.6 MB chunk.

### P2 — Hibrit sağlayıcılar ve ileri orkestrasyon

- [ ] **ADAPTER-001:** Claude entegrasyonu ve SDK izin köprüsü.
  - [x] Resmî headless CLI harness ile API anahtarlı otomatik görev adaptörü (`--bare`, `ANTHROPIC_API_KEY`), worktree, stdin JSON, native session/resume, sonuç doğrulaması ve context/mesaj devri. Ajan merkezinde test seçeneği ve modelsiz CLI kontrolü. Ürün bağlantısı abonelik OAuth'u sunmaz. Gerçek API anahtarlı generation henüz doğrulanmadı.
  - [x] Headless oturum bildirimi stream/replay/terminal sonuç boyunca tekilleştirildi; erken kimlik saklama korundu. Claude terminal hata ayrıntıları başarılı ve başarısız süreç çıkışlarında maskelenerek korunur; iki regresyon testi eklendi.
  - [ ] SDK canUseTool / interaktif izin köprüsü ve gerçek araç/resume kabul testi.
- [x] **ADAPTER-002:** Resmî Antigravity `agy` headless CLI otomatik adaptörü; Python SDK alternatifi araştırıldı, Node çekirdeğine CLI doğrudan bağlandı. Init/conversation ID erken saklama, açık resume, SUCCESS result, sandbox talebi, worktree/diff/onay ve kalıcı context/mesaj devri. Yerel 1.4.0 kısa gerçek mesajla yanıt verdi. Kod/araç/resume ve sandbox kabul testleri ayrıca açık. [Araştırma ve sınırlar](providers.md).
- [ ] **ADAPTER-003:** OpenAI/Anthropic/Google ve uyumlu modeller için doğrudan API adaptörleri ve kontrollü dosya/terminal tool-loop.
- [ ] **ADAPTER-004:** ACP üzerinden başka coding ajanlarını; MCP üzerinden ortak araçları bağlama.
  - [x] Resmî ACP kaynaklarında OpenCode, Gemini CLI, Qwen Code, Goose ve Copilot gibi adaylar araştırıldı; izin/capability/session/cancel kabul koşulları [providers.md](providers.md) içinde kaydedildi. Henüz ACP adaptörü uygulanmadı; Free model erişimi garanti sayılmaz.
- [ ] **ORCH-001:** Yönetici ajan atama/değiştirme, planı görev DAG'ına dönüştürme, kullanıcı denetimiyle yeniden planlama.
- [ ] **ORCH-002:** Bütçe/token/kota, rate-limit, timeout, eşzamanlılık, başarısızlık ve maliyet politikaları.
- [ ] **ORCH-003:** Ajan bazlı yetki profilleri, kimlik bilgilerini OS credential store'da saklama, gizli bilgileri context'ten uzak tutma.
- [ ] **RELEASE-001:** Windows paketleme, otomatik güncelleme, kurulum/dağıtım ve kabul testleri.

## Devam ederken

20 Ekim goal çalışması: UI-003 ajan ayarları, CORE-013 kalıcı ajan bağlaması ilk adımı ve UI-006 test raporu/merge çözüm akışı tamamlandı. **67/67 test**, TypeScript ve yeni ajan formu/test raporu/gerçek Git çakışma çözümünü doğrulayan Electron smoke başarılı. Gerçek model çağrısı yapılmadı. Sırada CORE-009 canlı inbox ve UI-007 editör geliştirmeleri var.

1. `D:\WebGpt` içinde `git status --short` ve `git log -5 --oneline` ile durumu kontrol et.
2. `npm install` (gerekiyorsa), ardından `npm run typecheck` ve `npm test` çalıştır.
3. Codex App Server ve OpenCode Server köprüleri tamamlandı; [permissions.md](permissions.md) desteklenen kapsamları açıklar. Varsayılan exec adaptörleri interaktif izin desteklemez. Modelsiz yerel kontrol: `npm run smoke:opencode`.
4. Antigravity ve Claude API anahtarlı headless görev adaptörleri, ortak sonuç zarfı, test raporları, merge çözümü ve UI ajan ayarları eklendi. `agentmesh.hybrid.example.json` plan/uygulama/review zincirini gösterir. Sırada canlı inbox (CORE-009), editör (UI-007), ACP ve config revizyonları (CORE-013) var. Gerçek kod/araç/resume smoke'ları (CORE-008) hâlâ açık.
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
- Gerçek kısa yanıtlar: Codex, Antigravity ve native TUI üzerinden OpenCode Space Bunny Free. Gerçek çok ajanlı kod/araç/resume uçtan uca kabulü henüz yapılmadı; Claude API anahtarıyla model erişimi doğrulanmadı.
- OpenCode için OS seviyesinde izolasyon kanıtlanmadı; mevcut `allowedPaths` denetimi işlem sonrasındadır.
- Codex App Server ve OpenCode Server için araç onayı köprüleri var; gerçek zamanlı *ajanlar arası* mesaj teslimi eksik. OpenCode Server şu an 1.19.x v1 şemasına bağlıdır ve yalnızca bash/read/edit kapsamlarını sunar. Log filtresi bilinen biçimleri tanır; keyfi kişisel veri için garanti vermez.
- Git merge conflict otomatik çözülmüyor; masaüstünde görev worktree'sinde elle çözüm ve yeni digest onayı var. Büyük dosyalar/özel Git çakışmaları harici araç gerektirebilir.
- Antigravity ve Claude headless görev adaptörleri var; interaktif izin köprüleri yok. Claude ürün bağlantısı API anahtarı ister. Doğrudan genel API harness ve ACP henüz uygulanmadı.
- Native provider sohbetleri tek bir birleşik konuşma geçmişi değildir; paylaşılan veri yapılandırılmış görev/context/mesaj kayıtlarıdır.
