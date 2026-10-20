# Otomatik ajan bağlantıları

18 Ekim 2026 araştırması ve yerel doğrulama. Amaç, terminale elle iş yazmak yerine scheduler'ın ayrı worktree'de ajan çalıştırması, native session kimliğini kaydetmesi, sonucu diğer görevlere aktarmasıdır.

| Sağlayıcı | Desteklenen yol | AgentMesh durumu |
| --- | --- | --- |
| Codex | exec / App Server | Otomatik görev, session, diff/onay; App Server tek isteklik araç izni. Gerçek selamlama doğrulandı. |
| OpenCode | run / HTTP Server | Otomatik görev adaptörleri var. Free model erişimi bu yollarda ayrıca sınırlanabilir. Space Bunny Free yalnızca native TUI yolunda gerçek yanıtla doğrulandı; TUI scheduler üyesi sayılmaz. |
| Antigravity | Resmî `agy` headless stream-json | Yeni otomatik adaptör. Görev/context/inbox stdin üzerinden, erken conversation ID, açık resume, SUCCESS sonucu ve normal worktree/onay akışı. Yerel CLI 1.4.0; gerçek kısa mesaj başarılı. |
| Claude Code | Resmî `claude -p` stream-json | Yeni otomatik adaptör. init/session, açık resume, başarılı terminal result, görev/context/inbox ve worktree/onay akışı. Yerel 2.1.301; ürün bağlantısı --bare ve ANTHROPIC_API_KEY kullanır. Başarılı gerçek generation henüz doğrulanmadı. |
| Gemini CLI, Qwen Code, Goose, Copilot ve diğer ACP ajanları | Agent Client Protocol | Araştırıldı; ortak ACP istemcisi henüz eklenmedi. Her sağlayıcı/sürüm için initialize, capability, izin, dosya/terminal ve iptal kabul testleri gerekli. |

## Kullanım

`agentmesh.hybrid.example.json`, **Antigravity plan → Codex uygulama → Claude inceleme** görev zincirini gösterir. `repoPath` değerini ilk commit'i yapılmış temiz Git projenize göre ayarlayıp kişisel config dosyası oluşturun. Masaüstünde config'i açın ve **Ajanları başlat** düğmesine basın. Antigravity/Codex kurulu CLI hesaplarını, Claude ANTHROPIC_API_KEY ortam değişkenini kullanır; gerçek maliyet/kota ve dosya etkisi oluşabilir. Antigravity ve Claude için `transport: "exec"` kullanılır. Model boşsa native varsayılan geçerlidir.

Plan sonucunun özeti otomatik ortak context'e girer. Uygulama dosya değiştirdiyse reviewer hemen çalışmaz: görev `pending_review` olur. Kullanıcı tam digest'i onaylayınca kod ayrı entegrasyon dalına alınır, context/mesajlar yayınlanır ve sonraki çalıştırmada bağımlı görev onaylı kodu görür. Kullanıcı ana dalı otomatik değiştirilmez. Kalıcı görev/session/sonuç/context/mesajlar SQLite'tan geri yüklenir.

Mesaj ekranında **Antigravity · CLI** ve **Claude · API anahtarı** seçenekleri de var. Bunlar görev orkestrasyonundan ayrı, proje dışındaki geçici dizinde kısa bağlantı testleridir. Antigravity testinde plan modu/sandbox, Claude testinde plan modu ve kapalı araç listesi kullanılır. Native uygulama çıkışından sonra Windows geçici dosya kilitleri kısa süre tekrar denenir; temizleme hatası asıl sağlayıcı hatasını gizlemez.

## İzin ve sonuç sınırı

Antigravity headless, kullanıcının native izin ayarlarını kullanır. Çalışma alanındaki dosya işlemleri native politika kapsamında yapılabilir; onay bekleyen komutlar soft-deny olabilir. `--sandbox` istenir; Windows'ta bunun OS seviyesindeki etkisi ayrıca doğrulanmalıdır. Genel izin atlama seçeneği eklenmez.

Claude görevleri `acceptEdits` ve açık yerleşik araç listesiyle çalışır; komutlar için genel otomatik onay veya izin atlama verilmez. Ürün bağlantısı `--bare` ile kullanıcı hook/eklenti keşfini ve OAuth/keychain girişini yüklemez; `ANTHROPIC_API_KEY` zorunludur. Her iki yeni adaptör de **interaktif araç izni köprüsünü desteklemiyor**; bu yetenek UI'da false gösterilir. Çalıştırılamayan bir testin başarı sayılmaması için görev talimatı gerçek doğrulamaları ve eksikleri ayırmasını ister.

`allowedPaths` hâlâ işlem sonrası denetimdir. Yapılandırılmış sonuç sürüm/alan/alıcı sınırlarından geçer; tamamlanmamış, hatalı, çoğul veya farklı session'a ait native sonuçlar başarı sayılmaz. Native kimlik sonuç gelmeden kaydedilir, böylece kesilmiş görev explicit retry ile aynı kimliği kullanabilir. Gerçek sağlayıcılarda yazma/araç/resume ve tüm alt süreç ağacı kabul testleri hâlâ CORE-008/010 altında açık.

## Test kanıtı

- Sahte native süreç/runner testleri: Antigravity ve Claude argümanları, stdin prompt/context, session/resume, erken kimlik, hata ve tamamlanma doğrulaması.
- 20 Ekim regresyon doğrulaması: stream/replay/terminal sonuç aynı oturumu yalnızca bir kez bildirir; Claude terminal hata ayrıntıları süreç çıkış kodundan bağımsız olarak maskelenerek korunur. Toplam 60 test, TypeScript kontrolü ve Electron desktop smoke başarılı; bu doğrulamada gerçek model çağrısı yapılmadı.
- Gerçek Git worktree + SQLite entegrasyon testi: Antigravity planı → Claude dosya değişikliği → digest onayı → Antigravity review. Structured fact ve devir mesajı onaydan önce yayınlanmaz; sonraki ajana aktarılır ve yeniden açılışta korunur. Bu test **gerçek model çağırmaz**.
- Gerçek Antigravity 1.4.0 selamlama: `Selamlar! Size nasıl yardımcı olabilirim?`, yaklaşık 7.6 sn. Kod yazma veya resume testi değildir.
- Claude 2.1.301 gerçek mesaj denemesi: `OAuth session expired and could not be refreshed`. İlk native tanı denemesi bu sonucu verdi; ürün bağlantısı sonrasında resmî üçüncü taraf entegrasyon yönlendirmesine göre --bare/API anahtarı yoluna sınırlandı. API anahtarıyla başarılı model erişimi henüz doğrulanmadı. AgentMesh kimlik bilgisi çıkarmaz veya başka sağlayıcıya taşımaz.

## Resmî araştırma kaynakları

- [Antigravity headless otomasyon](https://www.antigravity.google/docs/cli/headless/): stdin NDJSON, terminal result/status ve conversation ile resume. Bu yol mevcut Node orkestratörüne ek Python runtime gerektirmiyor.
- [Antigravity Python SDK](https://www.antigravity.google/docs/sdk/overview): alternatif resmî yerel ajan runtime'ı; SDK sidecar/policy köprüsü ileri aşamada değerlendirilebilir. Yerel IDE oturumu ile bulut API'nin erişim/ücretlendirmesi aynı kabul edilmez.
- [Claude programatik CLI](https://code.claude.com/docs/en/headless), [CLI seçenekleri](https://code.claude.com/docs/en/cli-reference): yapılandırılmış CLI otomasyonu. [Agent SDK ürün kimlik doğrulaması](https://code.claude.com/docs/en/agent-sdk/overview) üçüncü taraf ürünler için API anahtarı yolunu belirtir; SDK izin callback'leri sonraki geliştirmedir.
- [ACP'nin ajan listesi](https://agentclientprotocol.com/get-started/agents), [ACP initialize/capability sözleşmesi](https://agentclientprotocol.com/protocol/v1/initialization), [OpenCode ACP](https://docs.opencode.ai/docs/acp/): ortak protokol için adaylar. ACP sunması belirli modelin, ücretsiz katmanın veya hesabın erişimine garanti değildir.

Ekran koordinatı/OCR ile terminalden sonuç kazıma, özel IDE endpoint'leri, OAuth token çıkarma veya sağlayıcı kimliği taklidi entegrasyon yolu olarak seçilmedi.
