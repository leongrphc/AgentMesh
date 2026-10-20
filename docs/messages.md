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

## Ajanların canlı notları

Codex App Server tamamlanan ara assistant mesajından şu zarfı okuyabilir:

```json
{"agentmeshMessageVersion":1,"key":"question-1","to":"reviewer","kind":"question","body":"Bu uç durumu kontrol eder misin?"}
```

Araç stdout'u mesaj olarak yorumlanmaz. Biten/iptal edilen görev yeni mesaj yayınlayamaz. Canlı notlar soru/ilerleme içindir; kapsam veya araç izni vermez. Son sonuç zarfındaki `facts` ve `messages`, dosya değişikliği varsa mevcut insan diff onayını beklemeyi sürdürür.

Test kapsamı: eşzamanlı alıcılara dağıtım, idempotency ve içerik uyuşmazlığı, kalıcı replay/cursor, belirsiz teslim ve açık retry, oturumsuz retry bağlamı, iptal/geç yanıt, canlı olmayan adaptör kuyruğu, Codex tur kimliği ve bitiş yarışı. Electron smoke, çalışan demo görevine formdan canlı mesaj gönderip teslim kaydını doğrular.
