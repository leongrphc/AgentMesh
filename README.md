# AgentMesh IDE (çalışma adı)

Codex, OpenCode, Claude, Antigravity ve API tabanlı modelleri bir orkestratör etrafında birleştirmeyi hedefleyen **hibrit, çoklu ajan IDE** projesi.

> Durum: **MVP yerel backend prototipi**. SQLite tabanlı orkestratör, Git worktree yönetimi, insan onaylı entegrasyon dalı ve Codex/OpenCode CLI adaptörleri var. Varsayılan demo modelleri çağırmaz. Masaüstü arayüz, canlı olay akışı ve diğer sağlayıcılar henüz yoktur.

## Hızlı başlangıç

Windows / PowerShell, Node.js 22+:

```powershell
npm install
npm run typecheck
npm test
npm run demo
```

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
