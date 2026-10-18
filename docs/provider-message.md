# Sağlayıcıya gerçek mesaj testi

Uygulamada **Ajan merkezini aç → Gerçek mesaj testi** bölümünü kullanın. Codex veya OpenCode seçin, isterseniz model adını girin ve **Mesajı gönder · gerçek model** düğmesine basın. Varsayılan mesaj `Selam`. Model boşsa sağlayıcının kendi varsayılanı kullanılır; OpenCode model adı `provider/model` biçimindedir. Config oluşturmak veya gerçek bir proje açmak gerekmez; demo projesinde de bu bölüm gerçek bağlı CLI hesabını kullanır ve ücret/kota tüketebilir.

Her gönderim bağımsızdır; önceki mesajlar bağlam olarak eklenmez. En fazla 2000 karakter gönderilir. Yanıt veya hata aynı panelde gösterilir; başarılı yanıtta geçen süre belirtilir. Model çağrısı en fazla 90 saniye sürer. İptal düğmesi veya panelin kapatılması aktif isteği iptal eder. Test sürerken yeni test, ajan başlatma, bağlantı kontrolü ve proje değiştirme engellenir. Uygulama kapanırken de test iptal edilir. Otomatik yeniden deneme/farklı model deneme yapılmaz.

Proje dizini yerine sahipli geçici bir dizin kullanılır; proje dosyaları mesaja eklenmez. Codex App Server ephemeral thread, `read-only` sandbox, `never` approval, kapalı shell/web search ve kısa sohbet talimatıyla açılır; tüm izin istekleri reddedilir. OpenCode Server yalnızca deny-all izinli ayrı test session açar. Tamamlanınca bu session silinmeye çalışılır, sahipli server kapatılır ve geçici dizin kaldırılır. İptal/kopma sırasında native sağlayıcı geçmişinde kayıt kalabilir. Bu akış genel OS izolasyonu garantisi değildir; sağlayıcı hesabı ve kullanıcı genel CLI ayarları kullanılır.

Prompt ve yanıt AgentMesh journal/context/mesaj geçmişine yazılmaz. Yanıt maskeleme ve görüntüleme sınırından geçer. OpenCode hata görünümü yalnızca hata mesajı/HTTP kodu ve varsa yerel servis adresini gösterir; ham HTTP başlıkları, response body veya sağlayıcı metadata'sı aktarılmaz. Sağlayıcı kendi hizmetinde mesajı işleyebilir/saklayabilir. **Bağlantıları kontrol et** düğmesi ayrı kalır: model çağırmaz ve başarılı mesaj testinin yerine geçmez.

## 18 Ekim 2026 yerel sonuçları

- Codex 0.159.2: gerçek kısa selamlama isteği → `Selam!`, yaklaşık 5.5 saniye. App Server thread başlangıcında native sandbox enum'u `read-only`/`workspace-write`; turn policy türü `readOnly`/`workspaceWrite`. Önceki taklit testte thread enum'u yanlış biçimde bekleniyordu; native doğrulamayla düzeltildi.
- OpenCode 1.19.3, model seçilmeden: yerel `127.0.0.1:11434` hedefi bağlantı hatası verdi. CLI/sunucu erişilebilir olsa da bu varsayılan modelin inference servisine erişilemiyor.
- OpenCode `opencode/big-pickle`: sağlayıcı HTTP 403 ile isteği reddetti ve ücretsiz katmanın OpenCode içinden kullanılmasını istedi. Bu kısıt aşılmaya çalışılmadı; başka yapılandırılmış model/sağlayıcı seçilmeli. Başarılı OpenCode model yanıtı henüz doğrulanmadı.

Bu kayıtlar kod yazma, araç kullanma, session resume veya tüm modellerin/kotaların doğrulandığı anlamına gelmez. Bu kabul işleri CORE-008 kapsamında açık.

`npm test` geçici dizin temizliğini, iptal/tek istek kilidini, kayıt yapılmamasını, Codex salt okunur protokolünü, OpenCode deny-all/yanıt kimliği/hata/temizliği doğrular. `npm run desktop:smoke` form ve IPC hata görünümünü sınar; bu modda gerçek model çağrısı açıkça reddedilir.

Protokol referansı: [Resmî Codex App Server belgesi](https://developers.openai.com/codex/app-server/). Native OpenCode 1.19.3 şeması yerel `/doc` uç noktasından ayrıca doğrulandı.
