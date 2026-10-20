# Dosya sekmeleri ve kurtarma

Dosya ağacından açılan her dosyanın ayrı Monaco modeli vardır. En fazla 20 sekme açılır. Sekme geçişi taslağı, geri alma geçmişini ve imleç/kaydırma konumunu korur. Kaydet yalnızca seçili dosyayı yazar; işlem sürerken başka sekmeye geçmek kaydın hedefini değiştirmez. Kirli sekmeyi kapatmak veya disk sürümünü yeniden açmak açık vazgeçme onayı ister. Herhangi bir sekme kirliyken ajan başlatma engeli sürer.

Taslak kurtarma kayıtları Electron profilinin yerel `localStorage` alanında, proje kimliği + proje kökü + görev + worktree kapsamında tutulur. Başka projeye/göreve verilmez, journal/context/model istemine eklenmez. Bu bir şifreli sır deposu değildir; uygulama profilini silmek kurtarma kayıtlarını da siler.

Kayıt, yazma bittikten 300 ms sonra ve sayfa/görev geçişi veya normal kapanışta yapılır. Ani süreç/OS çökmesi son 300 ms'yi kaybettirebilir. Kapsam başına 4 MiB sınırı taslak metni ve özgün içeriği birlikte kapsar; tarayıcının toplam kotası daha erken dolabilir. Kayıt hatasında önceki kurtarma kaydı korunur ve görünür uyarı çıkar. Bu durumda diske kaydetmek gerekir. Geçersiz/eski sürüm kaydı otomatik silinmez veya üzerine yazılmaz.

Tekrar açılışta **kirli** dosyalar geri yüklenir; temiz sekmelerin listesi ve undo geçmişi uygulama yeniden açılışında saklanmaz. Kurtarma disk dosyasına otomatik yazmaz. Özgün SHA-256 digest korunur: disk sonradan değiştiyse eski taslakla kaydetme reddedilir. Dosya silinmiş, taşınmış veya erişilemez olmuşsa taslak sekmede korunur; metin kopyalanabilir, dosya geri getirildikten sonra kontrol yeniden yapılır.

Açık dosyalar ve görüntülenen klasör yaklaşık üç saniyede bir, çakışmayan bir sorgu döngüsüyle kontrol edilir. Temiz dosyanın disk içeriği otomatik alınır; kirli dosya korunur ve fark uyarısı gösterilir. Bu işletim sistemi watcher'ı değildir; değişiklik bildirimi sorgu gecikmesine bağlıdır. Kullanıcı “Yeniden aç” ile taslağından vazgeçip disk sürümünü alabilir. Kaydetme anında backend digest'i ayrıca kontrol eder.

Dosya/klasör oluşturma ve kaydetme yalnızca durdurulmuş görev worktree'sinde ve görev kapsamında yapılır. Salt okunur proje kökü, korunan yollar, junction/symlink ve mevcut dosyayı ezme engelleri sürer. Editör 1 MiB altındaki UTF-8 dosyaları açar. Yeni klasörler izin verilen dosya kalıplarının üst yollarına uymalıdır.

Doğrulama: kurtarma kapsamı, bozuk kayıt, boyut/kota ve önceki kaydı koruma testleri; gerçek Electron/Monaco'da iki taslak yazma, sekme geçişi, renderer yeniden yükleme, diskte dış değişiklik, eski digest reddi ve iki taslağı doğru dosyalara kaydetme. Gerçek sağlayıcı çağrısı yapılmaz.

`npm run desktop:smoke:editor` editör + merge senaryosunu tek başına, `npm run desktop:smoke` tüm masaüstü senaryolarıyla birlikte çalıştırır. Input smoke, Monaco'nun native EditContext alanına Chromium protokolü üzerinden metin girer.

Monaco motoru, CSS'i ve yerel worker dosyası ilk dosya açılışına veya taslak kurtarmaya kadar yüklenmez. Dosya ağacı, oluşturma formu ve disk listelemesi küçük editör kabuğunda çalışır. Dil kayıtları ve motor özellikleri kaldırılmadı; toplam dağıtım boyutunu azaltma iddiası yoktur.

20 Ekim build ölçümü (minify edilmiş, sıkıştırılmamış bayt):

| Kaynak | Önce | Sonra |
| --- | ---: | ---: |
| Başlangıçta yüklenen editör modülü | 2.631.581 | 10.627 |
| İhtiyaç anında yüklenen Monaco motoru | — | 2.621.687 |

Son build'de ilk ekranın toplam JavaScript bağımlılıkları 606.158 bayt; CSS bağımlılıkları 24.919 bayttır. Bunlar paket ölçümüdür, açılış süresi veya RAM ölçümü değildir. Dosya ilk açılırken motorun yükleme maliyeti ödenir; yükleme durumu ve hata görünümü vardır.

Her `desktop:build`, Vite manifest'inden gerçek statik bağımlılık grafiğini kontrol eder. Başlangıç JS bütçesi 800 KiB, CSS 40 KiB, editör kabuğu 64 KiB ve ertelenen motor 3 MiB sınırındadır. Monaco başlangıç grafiğine geri dönerse build başarısız olur. Son rapor `dist/renderer-budget.json` dosyasına yazılır. Tam Electron smoke, yerel protocol isteklerinden motorun dosya seçimi öncesinde istenmediğini ve ilk dosyada yüklendiğini ayrıca doğrular; taslak kurtarma smoke'u motorun yeniden yüklemede gerektiğinde kurulmasını kapsar.
