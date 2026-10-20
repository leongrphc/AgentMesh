# Dosya sekmeleri ve kurtarma

Dosya ağacından açılan her dosyanın ayrı Monaco modeli vardır. En fazla 20 sekme açılır. Sekme geçişi taslağı, geri alma geçmişini ve imleç/kaydırma konumunu korur. Kaydet yalnızca seçili dosyayı yazar; işlem sürerken başka sekmeye geçmek kaydın hedefini değiştirmez. Kirli sekmeyi kapatmak veya disk sürümünü yeniden açmak açık vazgeçme onayı ister. Herhangi bir sekme kirliyken ajan başlatma engeli sürer.

Taslak kurtarma kayıtları Electron profilinin yerel `localStorage` alanında, proje kimliği + proje kökü + görev + worktree kapsamında tutulur. Başka projeye/göreve verilmez, journal/context/model istemine eklenmez. Bu bir şifreli sır deposu değildir; uygulama profilini silmek kurtarma kayıtlarını da siler.

Kayıt, yazma bittikten 300 ms sonra ve sayfa/görev geçişi veya normal kapanışta yapılır. Ani süreç/OS çökmesi son 300 ms'yi kaybettirebilir. Kapsam başına 4 MiB sınırı taslak metni ve özgün içeriği birlikte kapsar; tarayıcının toplam kotası daha erken dolabilir. Kayıt hatasında önceki kurtarma kaydı korunur ve görünür uyarı çıkar. Bu durumda diske kaydetmek gerekir. Geçersiz/eski sürüm kaydı otomatik silinmez veya üzerine yazılmaz.

Tekrar açılışta **kirli** dosyalar geri yüklenir; temiz sekmelerin listesi ve undo geçmişi uygulama yeniden açılışında saklanmaz. Kurtarma disk dosyasına otomatik yazmaz. Özgün SHA-256 digest korunur: disk sonradan değiştiyse eski taslakla kaydetme reddedilir. Dosya silinmiş, taşınmış veya erişilemez olmuşsa taslak sekmede korunur; metin kopyalanabilir, dosya geri getirildikten sonra kontrol yeniden yapılır.

Açık dosyalar ve görüntülenen klasör yaklaşık üç saniyede bir, çakışmayan bir sorgu döngüsüyle kontrol edilir. Temiz dosyanın disk içeriği otomatik alınır; kirli dosya korunur ve fark uyarısı gösterilir. Bu işletim sistemi watcher'ı değildir; değişiklik bildirimi sorgu gecikmesine bağlıdır. Kullanıcı “Yeniden aç” ile taslağından vazgeçip disk sürümünü alabilir. Kaydetme anında backend digest'i ayrıca kontrol eder.

Dosya/klasör oluşturma ve kaydetme yalnızca durdurulmuş görev worktree'sinde ve görev kapsamında yapılır. Salt okunur proje kökü, korunan yollar, junction/symlink ve mevcut dosyayı ezme engelleri sürer. Editör 1 MiB altındaki UTF-8 dosyaları açar. Yeni klasörler izin verilen dosya kalıplarının üst yollarına uymalıdır.

Doğrulama: kurtarma kapsamı, bozuk kayıt, boyut/kota ve önceki kaydı koruma testleri; gerçek Electron/Monaco'da iki taslak yazma, sekme geçişi, renderer yeniden yükleme, diskte dış değişiklik, eski digest reddi ve iki taslağı doğru dosyalara kaydetme. Gerçek sağlayıcı çağrısı yapılmaz.

`npm run desktop:smoke:editor` editör + merge senaryosunu tek başına, `npm run desktop:smoke` tüm masaüstü senaryolarıyla birlikte çalıştırır. Input smoke, Monaco'nun native EditContext alanına Chromium protokolü üzerinden metin girer.
