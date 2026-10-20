# Canlı mesajlar ve görev inbox'ı

Mesajlar sekmesinden belirli bir ajana veya tüm proje ajanlarına soru/ilerleme notu gönderilebilir. Kaydetmek görev ya da model başlatmaz. Çalışan ve canlı teslimi destekleyen görevler mesajı alır; diğerleri bir sonraki açık çalıştırma veya yeniden denemede alır.

| Bağlantı | Çalışma sırasında teslim |
| --- | --- |
| Codex App Server | Aktif tur kimliğine bağlı `turn/steer` |
| Demo/mock | Çekirdek inbox aboneliği |
| Codex exec, OpenCode exec/Server, Antigravity, Claude headless | Sonraki görev isteminde teslim |
| OpenCode etkileşimli TUI | Scheduler inbox'ına bağlı değil |

Codex köprüsü `expectedTurnId` gönderir ve yanıttaki `turnId` değerini doğrular. Bu sözleşme [resmî App Server belgesi](https://learn.chatgpt.com/docs/app-server#steer-an-active-turn) ve kurulu CLI'ın `app-server generate-ts` çıktısıyla kontrol edildi. Sahte native süreçle tur bitişi/teslim yanıtı yarışları test edildi; gerçek model üzerinde canlı steer kabul testi CORE-008 kapsamında hâlâ açık. OpenCode Server'ın async prompt uç noktası tek başına güvenli aktif tur tesliminin kanıtı sayılmaz; native entegrasyonu açık iştir.

## Kalıcılık ve tekrar deneme

- Kaynak proje/görev/ajan kimliğini çekirdek atar. Kullanıcı kaynağı `@user`; alıcı proje ajanı veya `*` olmalıdır. Mesajlar başka projeye taşınmaz.
- Gönderim anahtarı proje ve kaynak görev kapsamında tekildir. Aynı anahtar ve içerik aynı mesaj kimliğini döndürür; farklı içerik reddedilir. Arayüz başarısız isteği aynı anahtarla tekrar deneyebilir.
- Teslim kayıtları ajan değil **görev** bazındadır. Aynı ajanla çalışan iki görev ayrı teslim alır. Cursor, ilgili mesajların başından itibaren kabul edilmiş kesintisiz adedi gösterir; pending ve uncertain ayrıca gösterilir.
- `sending` gönderim denemesini, `accepted` adaptör/native kabulünü, `queued` sonraki çalıştırmaya bırakmayı, `uncertain` kayıp yanıt/iptal/zaman aşımını belirtir. Kabul, modelin notu okuduğu veya uyguladığı anlamına gelmez.
- Her görevde tek sıralı teslim pompası çalışır. Canlı teslim 30 saniyede zaman aşımına uğrar; belirsiz yanıt aynı çalıştırmada otomatik tekrar edilmez. Uygulama yeniden açıldığında yarım `sending` kayıtları belirsiz olur; görev kendiliğinden başlatılmaz.
- Oturumu korunan yeniden denemede kabul edilmiş mesaj tekrarlanmaz. Native oturumu olmayan yeni çalıştırmaya önceki bağlam yeniden sağlanır. Belirsiz teslimler açık yeniden denemede tekrar gelebilir: taşıma **exactly-once garantisi vermez**. Sabit mesaj kimliği alıcıya tekrarlı işlemi önlemesi için aktarılır.
- Başlangıç istemi en fazla 64 mesaj / 128 KiB içerir. Mesaj gövdesi 16.384 karakterle; ajan kaynaklı canlı gönderim girişimleri çalıştırma başına 64 ile sınırlıdır. Büyük kuyruklar sonraki açık çalıştırmalara kalabilir.

## Masaüstü geçmişi

Mesaj geçmişi en yeni kayıttan başlayarak 20 mesajlık sayfalar halinde yüklenir. Daha eski/yeni sayfalara geçilebilir; yeni mesaj eklenmesi eski sayfaların cursor sınırını değiştirmez. Seçili görev filtresi görevin gönderdiği mesajları, ajanına gelen mesajları ve yayınları gösterir. Her okuma proje ve çalışma klasörü kapsamında doğrulanır.

Durum yayınları mesaj gövdelerini ve teslim kayıtlarını taşımaz; toplam sayı ve olay revizyonu taşır. Açık geçmiş sayfası yeni olaylarda yenilenir. Her mesaj için en fazla 50 teslim kaydı gösterilir; daha fazla alıcı varsa ilgili görev filtresinden o görevin teslimi incelenebilir. Inbox sayaçları ve canlı teslim davranışı korunur.

SQLite kullanıldığında çekirdek mesaj gövdelerini kalıcı bellekte veya checkpoint içinde tutmaz; mesaj üst bilgisi ve kaynak olay kimliği saklanır. Gövdeler olay kimliğinin indeksiyle ihtiyaç anında okunur: geçmiş sayfasında en fazla 20, başlangıç isteminde 64 mesaj / 128 KiB ve canlı teslimde sıradaki tek mesaj. Tekrar gönderim kontrolü de asıl içeriği diskten karşılaştırır. Açık tam snapshot/export isteği tüm gövdeleri yeniden oluşturur. Salt okunur bağlı arşivlerde aynı okuma yolu kullanılır.

SQLite teslim kayıtlarında da yalnızca devam eden `sending` işlemleri çekirdek belleğinde tutulur. Kabul edilmiş, ertelenmiş ve belirsiz teslimler görev/mesaj indeksleriyle diskten okunur. Aynı görev/mesaj çiftinin en son olayı geçerlidir; geçmiş ve arşivdeki eski durumlar yeni durumu ezmez. Yeniden açılışta yarım gönderimler yine `uncertain` olur. Inbox sayaçları hesaplanırken görev kapsamındaki geçici durum haritası oluşturulur; tam teslim snapshot'ı yalnızca açık istekte üretilir.

Checkpoint projeksiyonu sürüm 3'tür; eski projeksiyonlar journal olaylarından yeniden kurulur. Olay şeması değişmez. JSONL fallback tam gövdeleri ve teslim kayıtlarını bellekte tutmaya devam eder. Mesaj üst bilgileri ve görevler hâlâ geçmişle birlikte büyür; toplam çekirdek belleği için sabit sınır veya otomatik silme/saklama süresi henüz yoktur. Eski salt okunur arşivlerde yeni teslim indeksleri yoksa sorgular daha fazla disk taraması yapabilir; arşiv değiştirilmez. Testler sayfa sınırlarını, filtreleri, yeniden açılışı, checkpoint/arşiv rotasyonunu, gönderim tekilliğini ve her iki depoda canlı teslim/retry davranışını kapsar.

## Ajanların canlı notları

Codex App Server tamamlanan ara assistant mesajından şu zarfı okuyabilir:

```json
{"agentmeshMessageVersion":1,"key":"question-1","to":"reviewer","kind":"question","body":"Bu uç durumu kontrol eder misin?"}
```

Araç stdout'u mesaj olarak yorumlanmaz. Biten/iptal edilen görev yeni mesaj yayınlayamaz. Canlı notlar soru/ilerleme içindir; kapsam veya araç izni vermez. Son sonuç zarfındaki `facts` ve `messages`, dosya değişikliği varsa mevcut insan diff onayını beklemeyi sürdürür.

Test kapsamı: eşzamanlı alıcılara dağıtım, idempotency ve içerik uyuşmazlığı, kalıcı replay/cursor, belirsiz teslim ve açık retry, oturumsuz retry bağlamı, iptal/geç yanıt, canlı olmayan adaptör kuyruğu, Codex tur kimliği ve bitiş yarışı. Electron smoke, çalışan demo görevine formdan canlı mesaj gönderip teslim kaydını doğrular.
