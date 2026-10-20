# Doğrulanan journal arşivi

```powershell
npm run live -- --config agentmesh.config.json --archive D:\Yedekler\agentmesh-2026-10-20.sqlite
npm run live -- --verify-archive D:\Yedekler\agentmesh-2026-10-20.sqlite
```

Arşivleme, config'in işaret ettiği SQLite journal'ın **tamamını** kopyalar. Aynı journal birden fazla proje içeriyorsa hepsi dahil edilir. Olay kimliği, sıra numarası (boşluklar dahil), zaman, proje ve ham JSON metni korunur. Yeni dosya adı gereklidir; mevcut dosya, SQLite yan dosyaları veya kilit bulunan hedef reddedilir. Kaynak tek-yazar kilidi kullanılır; masaüstü journal'ı açık tutuyorsa önce kapatın.

Arşiv başlatmak ajan çalıştırmaz, task recovery yapmaz, pending izinleri çözmez ve kaynak olaylarını silmez. Kopya transaction içinde yazılır; manifest kayıt sayısını, ilk/son sıra numarasını, oluşturulma zamanını ve SHA-256 değerini içerir. Kopya kapatıldıktan sonra salt okunur bağlantıyla SQLite integrity_check ve olay özeti yeniden doğrulanır. Başarı yalnızca bu kontroller geçerse bildirilir. Başarısız işlem kendi oluşturduğu hedefi kaldırır; işlem zorla kesilirse tamamlanmamış dosya kalabilir, doğrulama geçmeden kullanılmamalıdır.

Özet algoritması `sha256-event-rows-v1`: sıra numarası artan her kayıt için `[sequence,id,at,project_id,payload]` JSON dizisinin UTF-8 bytes'ı ve tek LF satır sonu hash'e eklenir. `payload` ham JSON metnidir. Bu dosya bütünlüğü kontrolüdür, kimlik doğrulayan dijital imza değildir: manifesti ve içeriği birlikte değiştiren bir kişiye karşı özgünlük kanıtlamaz. Ayrı saklanan digest, kopyaları karşılaştırmak için kullanılabilir.

`--verify-archive` config veya sağlayıcı gerektirmez; dosyayı değiştirmez. Yanlış şema, bozuk SQLite, eksik/yanlış manifest, sayı/sıra/hash farkları başarısız çıkış üretir. Journal'ın ham talimat, mesaj ve sağlayıcı sonuçları korunur; bu dosya maskelenmiş destek raporu değildir. Otomatik yüklenmez veya paylaşılmaz.

## Kurtarma kapsamı

Arşivin bir **kopyası** üzerinde çalışın. Şema v2 olduğu için journal olarak açılabilir; normal orkestratör açılışı kesilmiş görevleri `needs_review` yapar ve eski bekleyen izinleri reddeder. Bu yeni olaylar kopyayı değiştirir, eski manifest artık onun için geçerli olmaz. Asıl arşivi doğrulanabilir halde koruyun. Kullanıcıya yönelik otomatik geri yükleme komutu henüz yoktur; canlı journal'ın üzerine dosya kopyalamayın.

Bu arşiv Git deposunu, worktree dosyalarını, native sağlayıcı oturumlarını veya uygulama dışı kimlik bilgilerini yedeklemez. Journal tek başına eksik çalışma dosyalarını kurtaramaz. Arşivleme şu anda aktif journal boyutunu küçültmez; checkpoint, eski kayıtları arşivden transparan okuma ve kullanıcı tarafından seçilen retention politikası açık iştir.

Testler: sıra boşlukları ve olay eşitliği, mevcut dosyanın korunması, kaynakta recovery oluşmaması, arşiv kopyasında gerçek replay/kurtarma, değiştirilmiş içerik/manifest ve bilinmeyen şema reddi, boş arşiv, config olmadan CLI doğrulaması.


## Replay checkpoint

```powershell
npm run live -- --config agentmesh.config.json --checkpoint
```

Checkpoint, aynı SQLite journal içinde açılış için türetilmiş bir durum önbelleği oluşturur. Sonraki masaüstü/CLI açılışı geçerli checkpoint'i yükler ve yalnızca sonrasındaki olayları replay eder. Kaynak journal ve arşivler tutulur; checkpoint hiçbir olayı silmez ve aktif dosyayı küçültmez. Elle oluşturulur, her işlem sonrası otomatik yeniden yazılmaz.

Komut normal açılış kurtarmasını **önce** uygular: kesilmiş görevleri needs_review yapabilir, eski izinleri reddedebilir ve belirsiz teslimleri işaretleyebilir; model çağırmaz. Bu yönüyle ham arşivleme komutundan farklıdır. Çalışan görev/izin/inbox varken checkpoint yazılamaz. Durumu yükledikten sonra journal'a başka olay eklenmişse eski orkestratör checkpoint yazamaz; yeniden açılması gerekir.

Durum sürümü, SHA-256, son sıra numarası ve kaynak olay kimliği doğrulanır. JSON alanlarında undefined opsiyonel değerler saklanmaz. Bozuk checksum, bilinmeyen biçim veya geçersiz projeksiyon durumunda kısmen yüklenen veriler temizlenir ve tüm journal replay edilir. Eski olay UPDATE/DELETE işlemleri checkpoint'i SQLite trigger'ı ile geçersizleştirir. Bu kontroller kaza/bozulma içindir; checksum, kötü niyetle hem içeriği hem özeti değiştiren kişiye karşı imza değildir.

Checkpoint tablo/indeksleri türetilmiş verilerdir; journal şeması v2 kalır. Arşivler sadece kaynak olayları ve arşiv manifestini taşır; checkpoint arşive kopyalanmaz. Böylece kurtarma checkpoint'e bağımlı değildir. Ajan ayarları son kayıt sorgusuyla, başka proje görev kimlikleri de indeksli kimlik sorgusuyla alınır; checkpoint kazanımını geri alan tam açılış taraması yapılmaz.

Checkpoint'in boyutu görev, güncel context, bekleyen öneri, mesaj ve teslim kayıtlarının sayısına bağlıdır. Geçmiş facts/paket/çözülmüş öneri içerikleri dahil edilmez. Tam dışa aktarım ve tanı raporu yine gerektiğinde journal'ı tarar. Aktif journal küçültme, soğuk arşivlerden birleşik okuma ve kullanıcı retention politikası açık işlerdir.
