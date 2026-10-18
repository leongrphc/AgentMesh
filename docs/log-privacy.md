# Log ve tanılama politikası

CLI stdout JSONL olayları yalnızca tam kayıt alındıktan sonra filtrelenerek görüntülenir. Stderr için kayıt sınırı tanımlı olmadığından filtreleme süreç kapanışında yapılır. Anahtar/token/özel anahtar/e-posta biçimleri için en iyi çaba maskelemesi uygulanır; keyfi kişisel veri tanıma garantisi yoktur. Görüntüleme 8192, kalıcı hata 2048 karakterle sınırlıdır. Süreç toplam 16 MiB veya JSONL satırında 1 MiB aşımında durdurulur.

Görev tanımları, sonuçlar, context, mesajlar, session ve review verileri çalışma verisidir. Bunlar görevleri sürdürmek için yerel journal'da korunur; log filtresi bu verileri sessizce değiştirmez. Eski journal kayıtları otomatik yeniden yazılmaz.

`npm run live -- --config agentmesh.config.json --diagnostics` yalnızca sürümlü olay sayıları raporunu stdout'a yazar. Kullanıcı/sağlayıcı metni, kimlikler, zamanlar, yollar ve oturumlar rapora alınmaz; eski kayıtlarda maskeleme dışında kalan sırlar da bu yolla dışa aktarılmaz. Rapor çalışma verilerinin yerine geri yüklenemez. Ham journal, review ve execute çıktıları destek raporu değildir.

Retention, disk şifreleme ve credential store entegrasyonu CORE-012 / ORCH-003 kapsamındadır.
