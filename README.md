# AgentMesh IDE (çalışma adı)

Codex, OpenCode, Claude, Antigravity ve API tabanlı modelleri bir orkestratör etrafında birleştirmeyi hedefleyen **hibrit, çoklu ajan IDE** projesi.

> Durum: **MVP masaüstü prototipi**. Electron/React arayüzünde proje seçimi, görevler, ajan durumları, canlı olaylar, Monaco dosya editörü, görev PTY terminalleri ve ortak context/mesajlar var. SQLite orkestratör, Git worktree ve Codex/OpenCode/Antigravity/Claude headless adaptörleriyle çalışır. Claude bağlantısı API anahtarı kullanır. Varsayılan demo modelleri çağırmaz.

## Hızlı başlangıç

Windows / PowerShell, Node.js 22.12+:

```powershell
npm install
npm run typecheck
npm test
npm run demo
```

## Masaüstü uygulama

```powershell
npm run desktop
```

Uygulama güvenli mock demo ile açılır. **Ajanları başlat** demo görevlerini bağımlılık sırasıyla çalıştırır. Görev seçerek iptal edebilir veya başarısız/iptal edilmiş görevi yeniden kuyruğa alabilirsiniz. Yeniden kuyruğa alma kendiliğinden çalıştırmaz.

Demo ilk plan görevinde sahte bir araç izni isteyerek karar panelini de gösterir. İzin vermek veya reddetmek gerçek komut çalıştırmaz. Gerçek Codex araç izinleri için ajan ayarına `"transport": "app-server"` ekleyin veya `agentmesh.app-server.example.json` örneğini kişisel config'inize uyarlayın. Bu transport masaüstünden çalıştırılır; `exec` varsayılanı aynı kalır. Yalnızca tek isteklik komut/kapsam içi dosya izinleri sunulur; ek network/filesystem ve oturum genelindeki izinler reddedilir. [İzin protokolü](docs/permissions.md).

**Ajan merkezi** sağlayıcı, bağlantı yöntemi, model/rol ve araç izni desteğini gösterir. **Bağlantıları kontrol et** model çağırmadan Codex hesap kaydını ve OpenCode sürümünü kontrol eder. Kimlik veya token UI'a aktarılmaz; bu sonuç model erişimi/kota garantisi değildir. OpenCode exec transportunda giriş durumu henüz doğrulanmıyor.

OpenCode etkileşimli izinleri için ajana `"transport": "server"` ekleyin veya `agentmesh.opencode-server.example.json` örneğini kullanın. Desteklenen sürüm ailesi **1.19.x**; her çalıştırmada `/doc` şeması ve çalışma dizini doğrulanır. Model verilirse `provider/model` biçimindedir. Sunucu yalnızca loopback üzerinde rastgele parola/portla açılır; bash/read/edit için bir kez izin verme veya reddetme sunulur. Diğer araç kapsamları kapalıdır. Ajan merkezinde Server bağlantısı seçili modelin sağlayıcı bildirimini kontrol eder; exec için sürüm kontrolü devam eder.

`npm run smoke:opencode`, gerçek yerel OpenCode ile geçici session oluşturma/okuma, izin politikası güncelleme, auth ve SSE kontrolü yapar. Model veya prompt göndermez; oluşturduğu geçici session ve klasörü temizler. Gerçek model turu ve araç yürütmesi bu testin kapsamında değildir.

**Görev ekle** ile ajan, talimat, dosya kapsamı ve bağımlılıklar tanımlanır. Bağımlılık çizimi seçili göreve geçiş sağlar. **Paralel ajan** ayarı 1–8 aralığındadır; görevler ve ayar yeniden açıldığında korunur. CLI'de config içindeki açık `maxParallel` değeri önceliklidir; belirtilmemişse kalıcı proje ayarı kullanılır. Olay paneli son 200 olayı yeniden yükler; ham CLI çıktıları kalıcı geçmişe yazılmaz.

Gerçek proje için **Proje ayarlarını aç** ile `agentmesh.config.json` seçin; aşağıdaki CLI bölümündeki yapılandırma kullanılır. Gerçek çalıştırma ayrıca uygulama içinde açıkça başlatılır. Aynı proje CLI ile ortak SQLite günlüğünü kullanır; iki uygulama aynı anda yazamaz. Demo kayıtları Electron kullanıcı veri klasöründedir.

Worktree oluşmuş bir görevi seçip **Değişiklikleri incele** ile commit edilmiş değişiklikler dahil diff, yeni dosyalar ve ajanın bildirdiği test raporlarını görün. Bekleyen digest ile eşleşen değişiklikler **Onayla ve birleştir** ile ayrı entegrasyon dalına alınır. Merge çakışırsa **Çözümü görev alanında aç**, dosyayı düzenle veya açıkça sil, ardından yeni diff/digest'i onayla. Eski sürümde bekleyen incelemeleri **İncelemeyi yenile** ile güncelleyin. [Çözüm akışı ve sınırlar](docs/merge-review.md).

**Dosyalar** bölümü seçili görevin çalışma alanını gösterir. Worktree henüz oluşmamışsa proje kökü salt okunur açılır. Durdurulmuş görev worktree'sindeki kapsam içi UTF-8 dosyaları (en fazla 1 MiB) düzenlenebilir; disk üzerinde değişmiş dosyanın üzerine eski içerik yazılmaz. Kaydettikten sonra **İncelemeyi yenile** yeni digest üretir; onay ayrıca gerekir. Monaco/worker dosyaları yerel paket içindedir; CDN kullanılmaz. DOMPurify bağımlılığı audit düzeltmesi için `overrides` ile güncel yama sürümüne alınır.

**Terminal** bölümünde durdurulmuş görev worktree’sinde en fazla dört kabuk açabilirsiniz. Komutlar kullanıcı hesabınızın yetkileriyle çalışır; ajan dosya kapsamı uygulanmaz. Ajan başlatma veya onaydan önce terminal süreçlerini, proje değiştirmeden önce tüm sekmeleri kapatın. Terminal çıktısı journal'a kaydedilmez. [Kapsam ve yaşam döngüsü](docs/terminals.md).

**Ajan merkezini aç → Gerçek mesaj testi** ile Codex'e `Selam` gönderin. OpenCode için varsayılan **Etkileşimli terminal** ve **opencode/space-bunny-free** seçilir: **OpenCode terminalini aç**, native ekrana `Selam` yazıp Enter'a bas. Space Bunny Free bu yolda gerçek yanıtla doğrulandı; `run` ve Server bazı ücretsiz modellerde 403 verebilir. CLI run/HTTP Server tek mesaj seçenekleri ayrıca sunulur. Demo içinde de gerçek hesap kullanılır; maliyet/kota tüketebilir. Native terminal kendi devam eden konuşmasını ve izinlerini yönetir; kullanıcı yetkileriyle proje dışında çalışır. **Bağlantıları kontrol et** yalnızca modelsiz kontroldür. [Test kapsamı ve yerel sonuçlar](docs/provider-message.md).

**Antigravity** ve **Claude · API anahtarı** da mesaj testinde seçilebilir. `agentmesh.hybrid.example.json`, Antigravity plan → Codex uygulama → Claude review görev zinciridir; `repoPath` değerini kendi temiz Git deponuza göre ayarlayın. Görev sonuçları, ortak kararlar ve hedefli devir mesajları otomatik kaydedilip sonraki ajana aktarılır; dosya değişiklikleri insan digest onayından sonra yayınlanır. Antigravity gerçek selamlama yanıtıyla doğrulandı; Claude için `ANTHROPIC_API_KEY` gerekir. [Sağlayıcı yolları, araştırma ve kalan kabul işleri](docs/providers.md).

Projeyi yeniden açarken veya CLI `--execute` öncesinde aynı görev kimliğinin kayıtlı tanımıyla config karşılaştırılır. Başlık, talimat, ajan, bağımlılık veya kapsam değişmişse alan adlarıyla hata gösterilir; orijinal tanımı geri yükleyin ya da yeni görev kimliği kullanın. Arayüzden eklenmiş görevler ve proje günlüğündeki ajan ayarları korunur. Kullanılmış ajanların provider/model/transport/rol değişikliği engellenir; ayrıntılı geçmiş uzlaştırma ekranı henüz yoktur (CORE-013).

`npm run desktop:smoke`, görünür pencere açmadan gerçek Electron renderer/preload, Monaco'da dosya açma, PTY açma/komut/çıktı/boyutlandırma/kapatma, dört görevli demo ve formdan bağımlı beşinci görevi ekleyip çalıştırmayı doğrular; `dist/desktop-smoke.png`, `dist/desktop-editor.png` ve `dist/desktop-terminal.png` üretir. Pencere kapanırken kaydedilmemiş değişiklikler kontrol edilir, aktif işler ve terminaller kapatılır, SQLite kapatılır.

Demo, `.agentmesh/demo.sqlite` dosyasında olay geçmişini saklar. Eski `.agentmesh/demo-events.jsonl` varsa ilk açılışta SQLite'a aktarır. İkinci çalıştırmada tamamlanan görevleri yeniden çalıştırmaz. Sıfırdan denemek için (gerekirse yedekleyerek) iki dosyayı temizleyin:

```powershell
Remove-Item .agentmesh/demo.sqlite, .agentmesh/demo-events.jsonl -ErrorAction SilentlyContinue
npm run demo
```

Demo akışı: mimar görevi → backend ile frontend **paralel** → reviewer. Backend ve frontend ortak API sözleşmesini görür; reviewer iki ajanın çıktılarını ve kendisine gönderilen mesajları alır.

## Gerçek Codex/OpenCode CLI çalıştırma

Ajan merkezindeki **Proje ajanları** formu ile ajan ekleyebilir; henüz çalışmamış ajanların sağlayıcı, bağlantı, model ve rol talimatını değiştirebilirsiniz. Ayarlar proje günlüğünde saklanır, CLI tarafından da okunur ve kaynak JSON dosyasını değiştirmez. Çalışma geçmişi bulunan ajanlar için farklı kimlikle yeni ajan ekleyin. Kaynak config'in ajan listesi kayıtlı kaynak veya etkin ayarlarla uyuşmazsa açılış reddedilir. CLI dry-run yalnızca kaynak dosyayı gösterir; kalıcı ayarlar gerçek işlem öncesinde çözülür.

`agentmesh.config.example.json` dosyasını kopyalayıp **ilk commit'i yapılmış, temiz bir Git reposuna** göre `repoPath`, görevler ve `allowedPaths` desenlerini düzenleyin. Henüz Git başlatılmadıysa başka bir repo seçebilirsiniz.

```powershell
Copy-Item agentmesh.config.example.json agentmesh.config.json
# agentmesh.config.json içindeki repoPath'i hedef projeye göre düzenleyin
npm run live -- --config agentmesh.config.json
```

Bu komut yalnızca **dry-run** yapar; model çağrısı ve worktree oluşturmaz. Planı gördükten sonra gerçek çalıştırma için:

```powershell
npm run live -- --config agentmesh.config.json --execute
```

Canlı JSONL stdout olaylarını ve görev durumlarını izlemek için `--execute --stream` kullanın. Stderr, parçalara bölünmüş sırları filtrelemek için süreç kapanışında gösterilir. Tanınan anahtar/token/e-posta biçimleri maskelenir; JSONL satırı 1 MiB veya stdout/stderr toplamı 16 MiB sınırını aşarsa süreç durdurulur. Çalışan komutta `Ctrl+C`, aktif CLI süreçlerine iptal sinyali gönderir ve bekleyen görevleri iptal eder. İptal edilen işler `cancelled` olarak kalır; kısmi worktree dosyaları silinmez. Filtre keyfi kişisel veriyi tanımaz; görev sonuçları ve ortak context çalışma verisidir, logları dışarı paylaşmadan önce inceleyin.

İptal edilen, başarısız veya engellenmiş bir görevi tekrar çalıştırmadan önce `--review` ile kısmi dosyaları inceleyin ve ardından açıkça kuyruğa alın:

```powershell
npm run live -- --config agentmesh.config.json --review
npm run live -- --config agentmesh.config.json --retry backend-auth
npm run live -- --config agentmesh.config.json --execute --stream
```

`--retry` tek başına model çağırmaz. `backend-auth` yerine hedef görev ID'sini kullanın; aynı worktree varsa korunur.

`--execute`, gerçek CLI çağrıları yapar; kimlik doğrulama, kullanım limiti ve olası maliyetler bağlı olduğunuz CLI hesabına aittir. OpenCode için `--auto` kullanılmaz, Codex için `workspace-write` sandbox istenir. Bu **işletim sistemi düzeyinde bir izolasyon garantisi değildir**; özellikle OpenCode tool izinleri ayrıca değerlendirilmelidir. Otomatik push/deploy yapılmaz.

Dosya değiştiren görevler `pending_review` durumuna geçer. İncelenen diff'e bağlı SHA-256 değerini kullanarak açıkça onaylayın:

```powershell
npm run live -- --config agentmesh.config.json --review
npm run live -- --config agentmesh.config.json --approve backend-auth --digest <reviewDigest>
npm run live -- --config agentmesh.config.json --execute
```

`backend-auth` örnek bir görev ID'sidir; `--review` çıktısındaki gerçek görev ID'sini ve `reviewDigest` değerini kullanın. Son `--execute`, onaylanan koda bağımlı görevleri başlatır. Diff değişirse eski digest ile onay reddedilir. Merge çakışmaları otomatik çözülmez; görev branch'i korunur, çözüm ve yeniden deneme gerekir.

Worktree'ler `.../.agentmesh-worktrees/`, SQLite ise `.../.agentmesh-data/` altında tutulur. Onaylı kod **ayrı AgentMesh entegrasyon dalına** birleştirilir; yeni bağımlı görevler bu dalı temel alır. Kullanıcının ana dalına otomatik merge yapılmaz. Dosya değiştirmeyen görev sonuçları doğrudan ortak context'e aktarılır; değişiklik yapan görevlerin sonuçları onaya kadar bekler.

## Tasarım belgeleri

Görev detayı ve değişiklik inceleme ekranında yapılandırılmış **Test raporları** gösterilir: başarılı, başarısız ve çalıştırılmadı. Bunlar ajanın bildirimidir; uygulama bağımsız test yürütmez. Dosyalar rapordan sonra değiştiyse incelemede eski rapor uyarısı görünür. İncelemeyi yenilemek testleri yeniden çalıştırmaz.

- [Görev listesi ve devam notları](docs/TASKS.md): tamamlanan işler, açık kartlar, öncelikler ve ertesi gün başlangıç adımları.
- [Sistem mimarisi](docs/architecture.md): bileşenler, hibrit bağlantılar, Git izolasyonu, veri modeli.
- [Canlı mesajlar ve inbox](docs/messages.md): mesaj formu, Codex aktif tur teslimi, kalıcı cursor ve belirsiz teslim/retry davranışı. Diğer otomatik bağlantılar mesajı sonraki istemde alır.
- [Ajan iletişim protokolü](docs/agent-protocol.md): görev, olay, mesaj ve context sözleşmeleri.
- [MVP planı](docs/mvp.md): kapsam, öncelik, kabul kriterleri ve bilinen açıklar.

## Şu anki kaynak yapısı

```text
src/
  core/
    contracts.ts       # Sağlayıcıdan bağımsız veri türleri
    journal.ts         # JSONL olay günlüğü
    sqlite-journal.ts  # SQLite WAL, migration ve tek-yazıcı kilidi
    orchestrator.ts    # Bağımlılık, paralel yürütme, kalıcı context, mesajlar
    worktrees.ts       # Git worktree ve dosya değişikliği incelemesi
  adapters/
    mock.ts            # Test / demo ajanı
    codex-cli.ts       # Codex CLI adaptörü
    opencode-cli.ts    # OpenCode CLI adaptörü
    cli-process.ts     # Native JSONL process runner
  demo.ts              # Uçtan uca örnek
  cli.ts               # Dry-run ve açıkça etkinleştirilen canlı çalışma
tests/
  orchestrator.test.ts
  integration.test.ts
docs/
  architecture.md
  agent-protocol.md
  mvp.md
```

Önemli sınır: `allowedPaths` işlem **sonrasında** değiştirilmiş dosyalara bakılarak doğrulanıyor; OS seviyesinde dosya erişimini engellemiyor. Gerçek CLI'lerin sürümleri kontrol edildi ve argüman/JSONL işleme test edildi, ancak ücretli/oturum açılmış bir model çağrısı yapılmadı.

Dosya ağacındaki **Yeni öğe** formu, durdurulmuş görev worktree’sinde dosya veya klasör oluşturur. Geçerli klasöre bir ad girin; alt klasörleri sırayla oluşturun. Mevcut dosyalar ezilmez ve görev kapsamı dışındaki yollar reddedilir. **Yenile** ağacı diskten tekrar okur; açık editör taslağını değiştirmez.

Editör en fazla 20 dosyayı ayrı sekmelerde açar. Kaydedilmemiş taslaklar proje/görev/worktree kapsamında yerel olarak kurtarılır; disk değişiklikleri izlenir ve taslağın üzerine yazılmaz. [Kurtarma ve sınırlar](docs/editor.md).

Monaco motoru ilk dosya açılışında veya taslak kurtarmada yüklenir; dosya ağacı ağır motoru beklemez. Desktop build, başlangıç bağımlılık grafiğini ve boyut bütçelerini denetler; raporu `dist/renderer-budget.json` dosyasına yazar.

**Ortak context** sekmesi kararların sürüm geçmişini ve çakışan önerileri gösterir. Farklı bir değer mevcut kararın üzerine yazılmaz; kullanıcı seçimi beklenir. Bekleyen kararlar yeni görevleri durdurur. CLI ile `--context` ve `--resolve-context` kullanılabilir. [Karar akışı ve SQLite sürüm 2 geçişi](docs/context-decisions.md).

Yeni görevlerde **Ortak context kapsamı** ile karar anahtarları seçilebilir. Bağımlılık özetleri otomatik eklenir; paket 128 kayıt/256 KiB ile sınırlıdır. Görev detayındaki **Hazırlanan context** her denemenin anahtar/sürüm listesini gösterir. CLI tanımında `contextKeys`, raporda `contextPackages` kullanılır. [Paket politikası ve sınırlar](docs/context-decisions.md#Görev-context-paketleri).

Journal arşivi: `npm run live -- --config agentmesh.config.json --archive yeni-arsiv.sqlite`. Doğrulama: `npm run live -- --verify-archive yeni-arsiv.sqlite`. Kaynak olayları silinmez; Git/worktree dosyaları dahil değildir. [Arşiv ve kurtarma kapsamı](docs/journal-archives.md).

Açılış checkpoint'i: `npm run live -- --config agentmesh.config.json --checkpoint`. Sonraki açılış yalnızca yeni olayları replay eder; geçersiz checkpoint tam replay ile kurtarılır. Kaynak journal silinmez veya küçültülmez. [Checkpoint davranışı](docs/journal-archives.md#replay-checkpoint).
