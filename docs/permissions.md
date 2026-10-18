# İzin köprüsü — araştırma ve protokol taslağı

18 Ekim 2026. Sağlayıcıdan bağımsız izin kuyruğu, Codex App Server adaptörü ve masaüstü karar paneli uygulanmıştır. OpenCode Server köprüsü ve gerçek modelle uçtan uca izin smoke testi henüz tamamlanmadı.

## Doğrulanan bağlantı yolları

- [Codex App Server](https://learn.chatgpt.com/docs/app-server): çift yönlü JSON-RPC; `item/commandExecution/requestApproval` ve `item/fileChange/requestApproval` kullanıcı kararını bekler. İstek thread/turn/item kimlikleriyle ilişkilidir. Ek dosya/ağ izinleri ayrı `item/permissions/requestApproval` isteğidir; yalnızca istenen alt küme verilebilir.
- [OpenCode Server](https://opencode.ai/docs/server/): izin yanıtı için `POST /session/:id/permissions/:permissionID` belgelenmiştir. Kullanılacak sürümün OpenAPI şeması ve olay akışı ayrıca doğrulanmalıdır; eski/yeni endpoint biçimleri varsayılarak karıştırılmamalıdır.

Mevcut `exec --json` / `run --format json` adaptörleri tek yönlü çıktı okur ve stdin'i kapatır. Bu çıktılarda izin isteği varmış gibi sahte bir etkileşim uygulamak yerine ayrı, çift yönlü transport adaptörleri eklenmelidir.

## Sağlayıcıdan bağımsız sözleşme

`permission.requested`: benzersiz requestId, projectId, taskId, executionId, provider, nativeRequestId, sessionId, işlem türü (command/file/network/unknown), açıklama, kapsam ve expiresAt. Ham native veri UI'a veya journal'a yazılmaz. Komut/yol bilgileri yapılandırılmış ve boyut sınırlı sunulur.

Kullanıcı `allow_once` veya `deny` kararı verir. İlk sürüm session/kalıcı izin desteklemez. Yanıt yalnızca aynı aktif execution ve native request için, bir defa gönderilir. Bilinmeyen istek veya desteklenmeyen kapsam reddedilir; istek kapsamını genişleten yanıt üretilmez.

`permission.resolved`: requestId, karar, karar kaynağı (user/timeout/cancel/disconnect), zaman. İzin sonucu görev tamamlandı anlamına gelmez; native işlem sonucu ayrıca beklenir. İptal, timeout, bağlantı kopması ve yeniden başlatma bekleyen izinleri kapatır; eski istekler tekrar onaylanamaz. Journal'da sırlar ve ham tool çıktısı tutulmaz.

## Uygulama kabul kriterleri

- Transport yetenek bildirimi; mevcut CLI adaptörleri için interaktif izin desteği false.
- Codex initialize/thread/turn yaşam döngüsü ve JSON-RPC request-response eşlemesi.
- OpenCode sürüm/şema doğrulaması, kimliği doğrulanmış yerel sunucu ve olay aboneliği.
- İzin bekleyen görev görünümü; dar IPC üzerinden açık kullanıcı kararı.
- Tekrar yanıt, yanlış görev/oturum, timeout, iptal, bağlantı kopması, restart ve desteklenmeyen kapsam testleri.
- Hiçbir hata yolu otomatik yetki yükseltmez; izin köprüsü OS sandbox yerine geçmez.

## Uygulanan v1 davranışı

Config'te Codex ajanına `"transport": "app-server"` eklemek çift yönlü bağlantıyı etkinleştirir; varsayılan `exec` adaptörünü değiştirmez. `agentmesh.app-server.example.json` başlangıç örneğidir. App Server görevleri masaüstünden başlatılır; CLI `--execute` bu transportu açık hata ile reddeder, CLI inceleme/digest onayı kullanılabilir.

Her görev için ayrı stdio App Server süreci açılır. `initialize` / `initialized`, thread start/resume ve turn akışı kullanılır; `workspaceWrite`, kapalı ağ, `on-request` ve kullanıcı reviewer seçilir. Bir sunucu isteği kullanıcıyı beklerken stdout okunmaya devam eder. Protokol 1 MiB satır / 16 MiB toplam çıktı ve zaman sınırlarıyla korunur.

Yalnızca doğru aktif thread/turn'den gelen komut ve kapsam içi dosya izinleri kullanıcı kuyruğuna alınır. İstekler project/execution/request/digest ile eşleşir; tek karar, 120 saniye timeout, iptal, kopma ve restart reddi uygulanır. Günlükte komut metni yerine digest ve karar tutulur. UI hassas değerleri maskeleyebilir. `acceptForSession`, `grantRoot`, ek filesystem/network izinleri ve desteklenmeyen server tool istekleri verilmez; ek izin isteği boş izin kümesi alır. Komut izni `accept` veya `decline` olarak yanıtlanır.

İzin bekleyen görev `running` olarak kalır; UI bunu “İzin bekliyor” alt durumu ile gösterir. Kullanıcı “Bir kez izin ver” dediğinde native onay penceresi de kapsamı gösterir; timeout/iptal sonrasında geç kalan karar geçersizdir. Model çağrısı yapmayan demo, sahte bir izin ister ve reddetme yoluyla da akışı tamamlayabilir; hiçbir gerçek komut çalıştırmaz.

Yerel Codex 0.159.2 JSON şeması, gerçek `initialize` / `account/read(refreshToken:false)` handshake'i ve model çağırmayan alt süreç testleri doğrulandı. Gerçek model turu, session resume ve native araç izinleri hesaplı uçtan uca sınanmadı (CORE-008).
