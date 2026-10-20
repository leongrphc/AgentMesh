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

Bu arşiv Git deposunu, worktree dosyalarını, native sağlayıcı oturumlarını veya uygulama dışı kimlik bilgilerini yedeklemez. Journal tek başına eksik çalışma dosyalarını kurtaramaz. Tek başına --archive aktif journal boyutunu küçültmez. Aktif dosyayı küçültmek için aşağıdaki açık --compact akışını kullanın.

Testler: sıra boşlukları ve olay eşitliği, mevcut dosyanın korunması, kaynakta recovery oluşmaması, arşiv kopyasında gerçek replay/kurtarma, değiştirilmiş içerik/manifest ve bilinmeyen şema reddi, boş arşiv, config olmadan CLI doğrulaması.


## Replay checkpoint

```powershell
npm run live -- --config agentmesh.config.json --checkpoint
```

Checkpoint, aynı SQLite journal içinde açılış için türetilmiş bir durum önbelleği oluşturur. Sonraki masaüstü/CLI açılışı geçerli checkpoint'i yükler ve yalnızca sonrasındaki olayları replay eder. Kaynak journal ve arşivler tutulur; checkpoint hiçbir olayı silmez ve aktif dosyayı küçültmez. Elle oluşturulur, her işlem sonrası otomatik yeniden yazılmaz.

Komut normal açılış kurtarmasını **önce** uygular: kesilmiş görevleri needs_review yapabilir, eski izinleri reddedebilir ve belirsiz teslimleri işaretleyebilir; model çağırmaz. Bu yönüyle ham arşivleme komutundan farklıdır. Çalışan görev/izin/inbox varken checkpoint yazılamaz. Durumu yükledikten sonra journal'a başka olay eklenmişse eski orkestratör checkpoint yazamaz; yeniden açılması gerekir.

Durum sürümü, SHA-256, son sıra numarası ve kaynak olay kimliği doğrulanır. JSON alanlarında undefined opsiyonel değerler saklanmaz. Bozuk checksum, bilinmeyen biçim veya geçersiz projeksiyon durumunda kısmen yüklenen veriler temizlenir ve tüm journal replay edilir. Eski olay UPDATE/DELETE işlemleri checkpoint'i SQLite trigger'ı ile geçersizleştirir. Bu kontroller kaza/bozulma içindir; checksum, kötü niyetle hem içeriği hem özeti değiştiren kişiye karşı imza değildir.

Checkpoint tablo/indeksleri türetilmiş verilerdir; küçültülmemiş journal şeması v2 kalır. Arşivler sadece kaynak olayları ve arşiv manifestini taşır; checkpoint arşive kopyalanmaz. Böylece kurtarma checkpoint'e bağımlı değildir. Ajan ayarları son kayıt sorgusuyla, başka proje görev kimlikleri de indeksli kimlik sorgusuyla alınır; checkpoint kazanımını geri alan tam açılış taraması yapılmaz.

Checkpoint'in boyutu görev, güncel context, bekleyen öneri ve devam eden gönderimlerin sayısına bağlıdır. SQLite mesaj gövdeleri ve üst bilgileri checkpoint içinde tutulmaz; geçmiş facts/paket/çözülmüş öneri içerikleri dahil edilmez. Projeksiyon sürüm 4'tür; eski projeksiyon sürümü tam replay ile yeniden kurulur. Tam dışa aktarım ve tanı raporu yine gerektiğinde journal'ı tarar. Küçültme ve birleşik okuma aşağıdaki --compact akışında uygulanır; isteğe bağlı otomatik bakım eşikleri aşağıda açıklanır.


## Aktif journal'ı küçültme

```powershell
npm run live -- --config agentmesh.config.json --compact D:\Yedekler\agentmesh-prefix-2026-10-20.sqlite
```

Bu açık bakım komutu önce normal açılış kurtarmasını ve checkpoint'i uygular. Ardından mevcut birleşik geçmişin tamamını yeni bir bağımsız arşive yazar ve doğrular. Arşiv bağlantısı ile aktif tablodan olayların çıkarılması aynı SQLite transaction'ında yapılır. Önceki checkpoint korunur. İşlem başarısız olursa kaynak olaylar ve bağlantı geri alınır; doğrulanmış arşiv kopyası kalabilir. Açık replay iterator'ı varken küçültme reddedilir.

İşlem sonrasında eski olaylar **bağlı arşivde**, yeni olaylar aktif journal'dadır. Arşiv SQLite URI `mode=ro` ile salt okunur bağlanır; replay, sürüm/paket/çözüm sayfaları, son olaylar, ayarlar ve tam dışa aktarım birleşik geçmişi kullanır. Sıra numaraları korunur ve yeni yazımlar kaldığı yerden devam eder. Daha sonra tekrar --compact çalıştırılabilir; yeni arşiv bütün birleşik geçmişi içerir, eski arşiv otomatik silinmez.

Bağlı arşiv artık isteğe bağlı yedek değil, journal'ın **zorunlu parçasıdır**. Mutlak dosya yolu kaydedilir; silmeyin, değiştirmeyin veya taşımayın. Her açılışta arşiv hash/sayı/sınırları yeniden doğrulanır. Eksik/bozuk arşivde açılış reddedilir ve kilit bırakılır; eksik geçmişle ajan başlatılmaz. Başka makineye taşımak gerekiyorsa birleşik geçmişten --archive ile bağımsız tam kopya alın. Otomatik bağlantı taşıma/geri yükleme arayüzü henüz yoktur.

Küçültme şemayı **v3** yapar; v2'ye kadar destekleyen eski uygulamalar bu dosyayı açamaz. Küçültülmemiş journal ve bağımsız arşivler v2 kalır. Fiziksel aktif alan VACUUM ve WAL checkpoint ile geri alınır. Çıktıda `compacted: true` aktarımın commit edildiğini, `vacuumed` alanı fiziksel bakımın da tamamlanıp tamamlanmadığını gösterir. Bakım başarısızsa `maintenanceError` döner; aktarım geri alınmış gibi raporlanmaz.

Rotasyon geçmişi silmez. İkinci rotasyon eski arşivi de içerdiğinden önceki kopyalar ayrıca yer tutabilir. Varsayılan olarak kopyalar silinmez; otomatik oluşturulan kopyalar için aşağıdaki isteğe bağlı saklama ayarı kullanılabilir. Arşiv doğrulaması açılışta bütün arşivi okur; checkpoint durum replay'ini azaltır ama bu bütünlük okumasını kaldırmaz. Görev projeksiyonlarının bellek politikası ayrı açık iştir.

## İsteğe bağlı otomatik bakım

Config dosyasına şu alan eklenebilir; varsayılan olarak otomatik bakım kapalıdır:

```json
"journalMaintenance": {
  "maxActiveEvents": 50000,
  "maxActivePayloadBytes": 67108864,
  "maxActiveAgeHours": 168
}
```

En az bir eşik seçilir; seçilen eşiklerden herhangi birine ulaşılması bakımı tetikler. Boş aktif journal tekrar arşivlenmez; bağlı arşivdeki geçmiş ölçümlere dahil edilmez.

| Ayar | Ölçüm | Geçerli tam sayı aralığı |
| --- | --- | --- |
| `maxActiveEvents` | Aktif olay sayısı | 100–10.000.000 |
| `maxActivePayloadBytes` | Aktif olay JSON içeriklerinin UTF-8 bayt toplamı | 1.024–1.099.511.627.776 |
| `maxActiveAgeHours` | Aktif olaylar arasındaki en eski kayıt zamanından geçen saat | 1–87.600 |

İçerik boyutuna SQLite indeksleri, checkpoint, boş sayfalar, WAL ve arşivler dahil değildir; bu bir fiziksel disk kotası değildir. Yaş kontrolü journal olay zamanını kullanır, mesajın içerdiği tarihi kullanmaz. Gelecekteki zaman damgası henüz yaş eşiğine ulaşmış sayılmaz; geçersiz zaman damgası varsa yaş politikası hata verir. Sayı politikası tek başına kullanılıyorsa içerik boyutu veya yaş taraması yapılmaz. CLI bakım sonucunun `reasons` alanı tetiklenen eşikleri gösterir.

Masaüstü projeyi açarken, görev çalıştırması bittiğinde, başka projeye geçerken ve kapanırken kontrol eder. CLI yalnızca `--execute` sonrasında kontrol eder; dry-run, inceleme, tanı ve açık arşiv komutları otomatik bakım başlatmaz. Çalışan görev/inbox veya bekleyen izin varsa checkpoint kapısı bakımı reddeder. Olay başına kontrol veya arka plan zamanlayıcısı yoktur; uzun bir çalıştırma boyunca eşik aşılabilir.

Eşiğe ulaşılınca checkpoint oluşturulur; journal'ın yanındaki `archives` klasöründe zaman damgası ve rastgele kimlik içeren yeni bir dosyaya doğrulanmış arşiv alınır ve aktif journal küçültülür. Bu arşiv uygulamanın çalışması için zorunludur. Mevcut arşivlerin üzerine yazılmaz. Ayarı kaldırmak gelecekteki otomatik bakımı kapatır; mevcut arşiv bağlantısını kaldırmaz.

Bakım hatası görev sonucunu değiştirmez. Masaüstü olay listesinde, CLI sonuç JSON'undaki `maintenance` alanında raporlanır. Doğrulanmış rotasyon sonrasında fiziksel küçültme başarısızsa bağlantı korunur ve `maintenanceError` raporlanır. Büyük geçmişlerde senkron doğrulama/kopyalama arayüzün açılışını veya kapanışını uzatabilir. Bu politika toplam disk kotası veya olay geçmişini yaşa göre silme sağlamaz.

### Yönetilen arşiv kopyalarını sınırlama

`journalMaintenance` içine `"keepManagedArchives": 3` eklemek, uygulamanın otomatik oluşturduğu en yeni üç arşiv kopyasını tutar; bağlı güncel kopya bu sayıya dahildir. Değer 1–1000 arasında tam sayı olmalıdır ve en az bir rotasyon eşiğiyle birlikte kullanılır. Varsayılan olarak bu alan yoktur ve kopyalar tutulur. Kopya temizliği, yeni rotasyon gerekmese bile aynı boşta bakım noktalarında uygulanır.

Yalnızca başarılı otomatik rotasyonla birlikte bu journal'ın `managed_archives` tablosuna kaydedilmiş dosyalar temizlenebilir. Elle `--archive`/`--compact` ile üretilmiş dosyalar, bu özellikten önce oluşturulmuş kopyalar ve başarısız rotasyondan kalan kayıtsız dosyalar kapsam dışıdır. Klasördeki dosyalar ad desenine göre topluca silinmez.

Silmeden önce bağlı güncel arşiv doğrulanır; eski kopyanın digest/sıra/sayı bilgisi ve bütün olaylarının güncel birleşik geçmişte aynı olduğu kontrol edilir. Bağlı dosya hiçbir zaman silinmez. Yönetilen klasör dışındaki veya bağlantı üzerinden erişilen dosyalar, kilitli ya da değiştirilmiş kopyalar korunur ve hata raporlanır. Dosya için exclusive kilit alınır; silme yalnızca o dosya ve kendi WAL/SHM yan dosyalarıyla sınırlıdır. Temizlik hatası yeni arşiv bağlantısını geri almaz; `retention.removed`, `retention.retained` ve `retention.errors` sonucu açıklamak için kullanılır. Hata halinde hedef kopya sayısı aşılabilir.

Bu ayar olayları değil, aynı geçmişin artık gerekli olmayan eski kopyalarını kaldırır. Saklanacak bağımsız yedek veya başka journal için `--archive` ile ayrı kopya alın; otomatik yönetilen dosyaları başka journal'lara bağlamayın. Her yeni arşiv bütün geçmişi içerdiğinden toplam bayt kotası garanti edilmez; rotasyon sırasında yeni kopya için geçici ek disk alanı gerekir.

Doğrulama: aktif dosyada olay kalmaması ve boyutun azalması; tam snapshot ve sıra eşitliği; arşivden öneri + aktif çözüm eşlemesi; iki dosyaya yayılan sayfalar; yeniden açılış/yazım/ikinci rotasyon; salt okunur arşiv; eksik/bozuk arşiv reddi; transaction hata enjeksiyonunda rollback; CLI ve masaüstünde yeni görev/ayarların korunması.
