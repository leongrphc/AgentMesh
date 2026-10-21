# Yerel deneme sürümü — 21 Ekim 2026

Bu kontrol noktası masaüstü MVP'sini denemek içindir. Kurulum paketi henüz yok; mevcut çalışma alanından açılır:

```powershell
cd D:\WebGpt
npm run desktop
```

## İlk deneme

1. Varsayılan demo projesinde **Ajanları başlat** seçeneğini kullanın. Demo gerçek model çağırmaz.
2. İlk görevin örnek izin isteğini onaylayın; bağımlı görevlerin ve paralel ajanların ilerlemesini izleyin.
3. Görevleri seçerek sonuçları, ortak context'i ve mesajları inceleyin.
4. Editörde dosya açma, sekmeler ve taslak kurtarmayı; Terminal bölümünde komut çalıştırmayı deneyin. Terminal normal kullanıcı yetkileriyle çalışır.
5. Uygulamayı kapatıp yeniden açarak kalıcı görev durumlarını kontrol edin. Tamamlanmış demo görevleri kendiliğinden yeniden çalışmaz.

Gerçek proje ve sağlayıcı kurulumu için [README](../README.md) adımlarını izleyin. Ajan merkezindeki gerçek mesaj testi hesap/kota kullanır; demo akışından ayrıdır.

## Doğrulama

- TypeScript kontrolü başarılı; tam test süiti **129/129** geçti.
- Masaüstü derlemesi ve Electron smoke başarılı: preload/sandbox, Monaco, taslak kurtarma, disk çakışması, gerçek PTY, demo görevleri, context kararları ve gerçek Git merge çakışması çözümü.
- Codex'in tur başlatma yanıtından önce gelen sonucu kaybetmesi düzeltildi; erken bildirimlerin kapsamı ve tampon sınırı test edildi.
- SQLite inbox sayaçları teslim geçmişini Node belleğine taşımadan hesaplanıyor; arşiv ve yeni olaylarla eşdeğerliği doğrulandı.
- Bu doğrulama turunda gerçek model çağrısı yapılmadı.

## Kalan kapsam

Tam ürün planı henüz bitmedi. Gerçek sağlayıcılarla kod/araç/resume kabul testleri, OpenCode canlı inbox, genel OS sandbox, config revizyonlarını uzlaştırma ekranı ve dağıtılabilir kurulum paketi açık. Ayrıntılı takip [TASKS.md](TASKS.md) içinde. Bu sürüm yerel deneme için doğrulanmış bir kontrol noktasıdır.
