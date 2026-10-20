# Değişiklik inceleme ve çakışma çözümü

Her yeni görev worktree'si başlangıç commit'ini `task.worktree.prepared.baseCommit` alanında saklar. İnceleme bu commit ile mevcut dosyaları karşılaştırır: ajanın kendi yaptığı commit'ler de diff ve `allowedPaths` denetimine dahildir. SHA-256 temel commit, sıralı dosya yolları, silme durumları, dosya modları ve içerik hash'lerini kapsar; stage veya commit işlemi tek başına onaylanmış içerik kimliğini değiştirmez.

## Çözüm akışı

1. **Onayla ve birleştir** görev branch'ini ayrı AgentMesh entegrasyon dalına almayı dener. Çakışmada entegrasyon merge'i geri alınır; görev branch'i ve sonuçları korunur. `task.merge.conflicted` çakışan yolları ve iki commit kimliğini saklar.
2. İnceleme ekranında **Çözümü görev alanında aç**, o anda gösterilen entegrasyon commit'ini görev worktree'sine `--no-commit` ile merge eder. Entegrasyon dalı bu adımda değişmez. İşlem öncesi hedef commit ve diff yeniden kontrol edilir; açık terminal süreçleri ve ajan çalışması engellenir.
3. Çakışan dosyayı seçip HEAD (görev) ve entegrasyon işaretlerini kaldırarak çözümü yazın. **Kaydet ve çözüldü işaretle** dosyanın içerik digest'ini ve kapsamını tekrar doğrular, yalnızca bu yolu stage eder. **Dosyayı silerek çöz** açık silme kararıdır. İkili dosyada mevcut sürümü koruma veya silme sunulur.
4. Bütün çakışmalar çözüldüğünde yeni diff ve digest görünür. **Onayla ve birleştir** için yeniden açık kullanıcı kararı gerekir. Eski digest geçerli değildir. Eski test raporları yeni içerikle eşleşmez ve eski olarak gösterilir.
5. Çözüm sırasında entegrasyon dalına başka görevler alınırsa, yeni çakışma aynı akışla tekrar çözülebilir. Görev sonuç/context/mesajları yalnızca başarılı entegrasyondan sonra yayınlanır.

Aktif merge ve temel commit journal/Git üzerinden yeniden açılışta korunur. Normal çözüm ekranını kapatmak merge'i iptal etmez; daha sonra aynı görevin incelemesine dönülebilir. Kaydedilmemiş textarea değişikliklerinde kapatma uyarısı vardır. Kullanıcının ana branch'i değiştirilmez.

## Sınırlar ve geçiş

- Metin editörü UTF-8 ve en fazla 1 MiB destekler. Symlink/junction ve kapsam dışı yollar üzerinden yazma yoktur. Büyük dosyalar veya özel Git çatışmaları görev terminali/harici araçla çözülebilir; terminal kapatıldıktan sonra inceleme yenilenir. Onay yine kapsam ve çözülmemiş index kayıtlarını denetler.
- Çakışma işaretleri kalan metin çözüldü olarak kaydedilemez. İkili dosyalar için görsel binary merge aracı yoktur.
- Yeni içerik digest biçimi nedeniyle önceki sürümde bekleyen onaylar yeniden incelenip yenilenmelidir. Başlangıç commit'i olmayan eski worktree'lerde branch'in entegrasyonla ortak atası kullanılır; eski tamamlanmış görevlerin kaydedilmemiş başlangıç noktası geriye dönük garanti edilemez.
- Git ve SQLite tek transaction değildir. Merge niyeti önce journal'a yazılır; belirsiz veya beklenmeyen Git durumu otomatik onaylanmaz. Tüm olası süreç çökme noktaları için kapsamlı kurtarma CORE-012 altında devam eder.

## Doğrulama

`tests/merge-resolution.test.ts`: gerçek Git/SQLite üzerinde commit sonrası diff, çözüme başladıktan sonra restart, değişen entegrasyon hedefi, ikinci çakışma, eski dosya/diff digest reddi, ana dalın korunması, ajanın commit ettiği kapsam dışı dosyanın reddi ve silme/yeniden oluşturma/ikili koruma.

`npm run desktop:smoke`: modelsiz, ayrı smoke reposunda gerçek çakışma oluşturur; renderer formu ve IPC üzerinden çözümü yazar. Yeni digest hazırlandıktan sonra servis üzerinden onaylar, entegrasyon içeriğini ve ana dalın değişmediğini doğrular. Native onay penceresine otomatik tıklamaz. `dist/desktop-merge.png` son çözüm incelemesini gösterir.
