# AgentMesh

Birden fazla kodlama ajanını (Codex, OpenCode, Claude, Antigravity) **aynı Git projesinde, ayrı dallarda ve paralel** çalıştıran yerel masaüstü IDE'si. Her görev, projenin içindeki `.agentmesh/` klasöründe kendi Git worktree'sinde yürür. Ajanın değişikliği, siz diff'i inceleyip onaylamadan hiçbir yere birleşmez.

> **Durum: çalışan prototip.** 7 Kasım'da gerçek modellerle doğrulandı: Claude Code ve Codex ayrı ayrı uçtan uca çalıştı. Karışık ekip senaryosunda Claude ile Codex aynı anda paralel çalıştı, ardından Claude ikisinin onaylanmış kodunu görerek devam etti (65 sn). Komutlar: `npm run e2e:claude`, `npm run e2e:codex -- codex1`, `npm run e2e:team -- claude codex:codex1`.

## 5 dakikada başla

Gereksinimler: Windows, Node.js 22.12+, Git ve şu ajanlardan en az biri:

- **Claude Code** (varsayılan, önerilen): kurulu ve giriş yapılmış olmalı (`claude auth login`; ya da `ANTHROPIC_API_KEY`). Görevler hesabının kullanım limitinden düşer.
- **Codex CLI**: `codex login`. Birden fazla Codex hesabını ayrı `CODEX_HOME` klasörlerinde tutuyorsan (`~/.codex-profiles/codex1` gibi), AgentMesh bunları bulur. Yeni projede Codex ajanı ilk profili kullanır; her Codex ajanının hesabı **Ajanlar** penceresinden seçilir. Codex'i `openai_base_url` ile yerel bir köprüye yönlendirdiysen o uygulama çalışıyor olmalı; bağlantı kontrolü bunu denetler.

```powershell
npm install
npm run desktop
```

1. Sol üstteki proje menüsünden **Klasör aç…** ile herhangi bir Git deposunu seç. Depoda en az bir commit olmalı ve commit edilmemiş değişiklik bulunmamalı.
2. **＋ Yeni görev** ile ajana ne yapacağını yaz. Başlık ve talimat yeterli; ajan olarak Claude ya da Codex seç.
3. **▶ Ajanları başlat**. Ajan görevi proje klasöründeki `.agentmesh/worktrees/` altında, kendi dalında yapar. Senin dosyaların bu sırada değişmez. İlerleme sağdaki **Etkinlik** panelinde akar.
4. Görev *İnceleme bekliyor* olunca **Değişiklikleri incele** → diff'e bak → **Onayla ve birleştir**. Onaylanan işler `agentmesh/integration-…` dalında birikir.
5. **Projeme uygula** ile onaylı işleri klasörünün açık dalına al. Çakışma olursa işlem geri alınır, projen değişmez.

AgentMesh projeye ait her şeyi seçilen klasörün içindeki `.agentmesh/` altına yazar ve bu klasörü `.git/info/exclude` ile Git'ten gizler. `.gitignore` dosyana dokunmaz. Önceki sürümlerin projenin yanına açtığı `.agentmesh-worktrees` klasöründeki eski görevler çalışmaya devam eder; temiz entegrasyon alanı ilk kullanımda klasörün içine taşınır.

Durdurulan ya da başarısız olan bir görevi denetçideki **Başka ajana devret** ile başka bir ajana verebilirsin (ör. Codex ile başlayıp Claude ile bitirmek). Yeni ajan aynı çalışma alanında, öncekinin bıraktığı değişikliklerden devam eder; sağlayıcı oturumu taşınmaz, yeni ajan kısa bir devir notuyla başlar.

Arayüz bir IDE düzenindedir: solda görevler (her ajan renkli bir hat, her görev bir durak), ortada dosya gezgini ve kod editörü, sağda seçili görevin denetçisi, altta terminal ve ajan akışı. `Ctrl+B` görev panelini, `Ctrl+J` alt paneli açıp kapatır; alt panelin yüksekliği sürüklenerek ayarlanır.

Uygulama son açtığın projeyle başlar. İlk açılışta model çağırmayan bir **demo** gösterir.

## Nasıl çalışır

```
 görev ──► orkestratör ──► ajan (Codex / OpenCode / Claude …)
              │                 │  kendi worktree'sinde, kendi dalında
              │                 ▼
              │           diff + SHA-256 özet
              ▼                 │
   bağımlı görevler ◄── siz onaylarsınız ──► entegrasyon dalı
```

- **Görevler ve bağımlılıklar.** "B, A bitince başlasın" diyebilirsin. Bağımsız görevler 1–8 paralel ajanla aynı anda çalışır.
- **Ortak context.** Ajanların sonuçları, kararları ve birbirine mesajları sonraki görevlere aktarılır. Çelişen kararları siz çözersiniz.
- **İzinler.** Codex (`app-server`) ve OpenCode (`server`) bağlantılarında ajan komut çalıştırmak isterse uygulama size tek seferlik izin sorar.
- **Kalıcılık.** Her şey yerel bir SQLite günlüğünde tutulur; uygulamayı kapatıp açınca kaldığın yerden devam edersin.

Ek ajanlar (OpenCode, Claude, Antigravity) üst bardaki **Ajanlar** penceresinden eklenir.

## Komutlar

| Komut | Ne yapar |
|---|---|
| `npm run desktop` | Masaüstü uygulamasını derleyip açar |
| `npm test` | Tüm otomatik testler (model çağırmaz) |
| `npm run typecheck` | TypeScript kontrolü |
| `npm run desktop:smoke` | Gerçek Electron penceresinde uçtan uca arayüz testi (model çağırmaz) |
| `npm run e2e:claude` | **Gerçek Claude Code** ile geçici depoda görev → inceleme → onay → merge (≈ 0,05 $ kullanım) |
| `npm run e2e:codex -- codex1` | Aynı tek görev testi, Codex ile (profil adı isteğe bağlı) |
| `npm run e2e:team -- claude codex:codex1` | Üç görevli gerçek ekip senaryosu: iki paralel ajan + onların koduna bağlı üçüncü görev. Argümansız çalıştırılırsa hepsi Claude ile |
| `npm run desktop:package` | Taşınabilir Windows klasörü üretir (`dist/releases`) |
| `npm run live -- --config <dosya>` | Masaüstü olmadan CLI ile config tabanlı çalıştırma ([ayrıntı](docs/reference.md#gerçek-codexopencode-cli-çalıştırma)) |

## Bilinen sınırlar

- Dosya kapsamı (`allowedPaths`) **çalıştırma sonrasında** denetlenir. Ajan süreci işletim sistemi sandbox'ında değildir (CORE-010).
- Claude bağlantısında izinler arayüzden sorulmaz. Görev worktree'sindeki dosya düzenlemeleri otomatik kabul edilir. Komutlarda Claude Code'un kendi varsayılan kuralları geçerlidir: salt okunur komutlar (ör. `git status`) çalışabilir, onay isteyenler çalışmaz. Arayüzden tek tek izin verme şu an Codex (`app-server`) ve OpenCode (`server`) bağlantılarında var.
- Kurulum sihirbazı, imzalı sürüm ve otomatik güncelleme yok.

## Belgeler

- [Ayrıntılı başvuru](docs/reference.md): tüm özellikler, CLI ve config biçimi
- [Görev listesi ve yol haritası](docs/TASKS.md)
- [Mimari](docs/architecture.md) · [Ajan protokolü](docs/agent-protocol.md) · [İzinler](docs/permissions.md) · [Sağlayıcılar](docs/providers.md)
