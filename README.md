# AgentMesh IDE (çalışma adı)

Codex, OpenCode, Claude, Antigravity ve API tabanlı modelleri bir orkestratör etrafında birleştirmeyi hedefleyen **hibrit, çoklu ajan IDE** projesi.

> Durum: **MVP masaüstü prototipi**. Electron/React arayüzünde proje seçimi, görevler, ajan durumları, canlı olaylar, Monaco dosya editörü, görev PTY terminalleri ve ortak context/mesajlar var. SQLite orkestratör, Git worktree ve Codex/OpenCode CLI adaptörleriyle çalışır. Varsayılan demo modelleri çağırmaz.

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

Worktree oluşmuş bir görevi seçip **Değişiklikleri incele** ile diff ve yeni dosyaları görün. Bekleyen digest ile eşleşen değişiklikler **Onayla ve birleştir** ile ayrı entegrasyon dalına alınır. Ardından bağımlı görevleri başlatabilirsiniz. Diff değişmişse onay reddedilir; commit edilmiş merge conflict ve tam test raporları için şimdilik CLI incelemesi gerekir.

**Dosyalar** bölümü seçili görevin çalışma alanını gösterir. Worktree henüz oluşmamışsa proje kökü salt okunur açılır. Durdurulmuş görev worktree'sindeki kapsam içi UTF-8 dosyaları (en fazla 1 MiB) düzenlenebilir; disk üzerinde değişmiş dosyanın üzerine eski içerik yazılmaz. Kaydettikten sonra **İncelemeyi yenile** yeni digest üretir; onay ayrıca gerekir. Monaco/worker dosyaları yerel paket içindedir; CDN kullanılmaz. DOMPurify bağımlılığı audit düzeltmesi için `overrides` ile güncel yama sürümüne alınır.

**Terminal** bölümünde durdurulmuş görev worktree’sinde en fazla dört kabuk açabilirsiniz. Komutlar kullanıcı hesabınızın yetkileriyle çalışır; ajan dosya kapsamı uygulanmaz. Ajan başlatma veya onaydan önce terminal süreçlerini, proje değiştirmeden önce tüm sekmeleri kapatın. Terminal çıktısı journal'a kaydedilmez. [Kapsam ve yaşam döngüsü](docs/terminals.md).

**Ajan merkezini aç → Gerçek mesaj testi** ile Codex veya OpenCode'a `Selam` yazıp gerçek yanıt alabilirsiniz. Demo içinde de bağlı hesap kullanılır; maliyet/kota tüketebilir. İsteğe bağlı model seçimi, yanıt/süre/hata ve iptal vardır. Her gönderim bağımsızdır; proje dosyaları gönderilmez. **Bağlantıları kontrol et** yalnızca modelsiz kontroldür. [Test kapsamı ve yerel sonuçlar](docs/provider-message.md).

Projeyi yeniden açarken veya CLI `--execute` öncesinde aynı görev kimliğinin kayıtlı tanımıyla config karşılaştırılır. Başlık, talimat, ajan, bağımlılık veya kapsam değişmişse alan adlarıyla hata gösterilir; orijinal tanımı geri yükleyin ya da yeni görev kimliği kullanın. Arayüzden eklenmiş görevler korunur; bunların ajanları config içinde bulunmalıdır. Ajan provider/model/transport geçmişini uzlaştırma ekranı henüz yoktur (CORE-013).

`npm run desktop:smoke`, görünür pencere açmadan gerçek Electron renderer/preload, Monaco'da dosya açma, PTY açma/komut/çıktı/boyutlandırma/kapatma, dört görevli demo ve formdan bağımlı beşinci görevi ekleyip çalıştırmayı doğrular; `dist/desktop-smoke.png`, `dist/desktop-editor.png` ve `dist/desktop-terminal.png` üretir. Pencere kapanırken kaydedilmemiş değişiklikler kontrol edilir, aktif işler ve terminaller kapatılır, SQLite kapatılır.

Demo, `.agentmesh/demo.sqlite` dosyasında olay geçmişini saklar. Eski `.agentmesh/demo-events.jsonl` varsa ilk açılışta SQLite'a aktarır. İkinci çalıştırmada tamamlanan görevleri yeniden çalıştırmaz. Sıfırdan denemek için (gerekirse yedekleyerek) iki dosyayı temizleyin:

```powershell
Remove-Item .agentmesh/demo.sqlite, .agentmesh/demo-events.jsonl -ErrorAction SilentlyContinue
npm run demo
```

Demo akışı: mimar görevi → backend ile frontend **paralel** → reviewer. Backend ve frontend ortak API sözleşmesini görür; reviewer iki ajanın çıktılarını ve kendisine gönderilen mesajları alır.

## Gerçek Codex/OpenCode CLI çalıştırma

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

- [Görev listesi ve devam notları](docs/TASKS.md): tamamlanan işler, açık kartlar, öncelikler ve ertesi gün başlangıç adımları.
- [Sistem mimarisi](docs/architecture.md): bileşenler, hibrit bağlantılar, Git izolasyonu, veri modeli.
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
