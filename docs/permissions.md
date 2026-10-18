# İzin köprüsü — araştırma ve protokol taslağı

18 Ekim 2026. Bu belge tasarımdır; çalışan izin köprüsü değildir.

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
