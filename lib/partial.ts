// lib/partial.ts
// -----------------------------------------------------------------------------
// MOD B (kısmi JSON'u tolere ederek akıtma) için yardımcı.
//
// SORUN: Streaming sırasında elimize {"maddeler":[ {...}, {...}, {... gibi
// YARIM bir JSON metni gelir. Tamamı gelmeden JSON.parse çalışmaz.
//
// ÇÖZÜM YAKLAŞIMI (mülakatta bunu soracaklar, iyi oku):
//   Yarım metni zorla kapatıp parse etmeye ÇALIŞMIYORUZ. Bunun yerine metni
//   karakter karakter tarıyoruz. "maddeler" dizisinin içindeyken süslü parantez
//   derinliğini (brace depth) ve string durumunu takip ediyoruz. Bir nesne
//   derinlik 0'a (yani dizi seviyesine) her geri döndüğünde, o nesne EKSİKSİZ
//   tamamlanmış demektir; SADECE o parçayı JSON.parse ediyoruz. Henüz kapanmamış
//   son nesneyi görmezden geliyoruz.
//
//   Böylece her delta geldiğinde yalnızca "tam" kartları gösteririz; yarı yazılı
//   bir kart ekranda titremez. String içindeki süslü parantezleri ({ } ") yanlış
//   saymamak için string ve kaçış (\) durumunu da takip ediyoruz.
// -----------------------------------------------------------------------------

/**
 * Yarım JSON metninden İÇİ TAMAMLANMIŞ madde nesnelerini ayıklar.
 * @param ham streaming ile o ana kadar birikmiş ham metin
 * @returns tamamlanmış nesnelerin dizisi (yarım kalan sonuncu hariç)
 */
export function tamamlananMaddeler(ham: string): unknown[] {
  // "maddeler" anahtarını ve ondan sonraki dizi başlangıcını bul.
  const anahtar = ham.indexOf('"maddeler"');
  if (anahtar === -1) return [];
  const diziBasi = ham.indexOf("[", anahtar);
  if (diziBasi === -1) return [];

  const sonuc: unknown[] = [];
  let derinlik = 0; // { } iç içe derinliği
  let nesneBasi = -1; // aktif (en dış) nesnenin başlangıç indexi
  let stringIcinde = false; // şu an bir "..." string'i içinde miyiz
  let kacis = false; // bir önceki karakter ters bölü (\) müydü

  for (let i = diziBasi + 1; i < ham.length; i++) {
    const c = ham[i];

    // String içindeysek, sadece string'in bitişini/kaçışı takip et.
    if (stringIcinde) {
      if (kacis) {
        kacis = false; // kaçırılan karakteri atla
      } else if (c === "\\") {
        kacis = true;
      } else if (c === '"') {
        stringIcinde = false;
      }
      continue;
    }

    if (c === '"') {
      stringIcinde = true;
    } else if (c === "{") {
      if (derinlik === 0) nesneBasi = i; // en dış nesne başladı
      derinlik++;
    } else if (c === "}") {
      derinlik--;
      if (derinlik === 0 && nesneBasi !== -1) {
        // En dış nesne kapandı -> tam bir madde elde ettik.
        const parca = ham.slice(nesneBasi, i + 1);
        try {
          sonuc.push(JSON.parse(parca));
        } catch {
          // Teoride buraya düşmemeli (tam nesneyi kestik). Düşerse atla.
        }
        nesneBasi = -1;
      }
    } else if (c === "]" && derinlik === 0) {
      // Dizi kapandı; sonrası bizi ilgilendirmiyor.
      break;
    }
  }

  return sonuc;
}
