# שלוחה 2/8 — שידורי טלוויזיה חיים באמצעות שרת שמע ברשת

הפתרון **לא** משתמש במנגנון שידור חי אינטרנטי של ימות או בשמות music_on_hold של ימות.
הקישור הטלפוני מבוצע באמצעות `routing_ip` לשרת SIP חיצוני (Asterisk, FreeSWITCH וכדומה).
השרת החיצוני הוא שקולט זרמי שידור *מורשים*, מחלץ את האודיו באמצעות FFmpeg,
ומזרים שמע טלפוני רציף (RTP/G.711) בחיבור SIP.

## מיפוי הקשות
1 כאן 11; 2 ערוץ 12; 3 ערוץ 13; 4 ערוץ 14; 5 i24NEWS; 6 ערוץ הכנסת.

## נדרש לפני הפעלה
1. שרת SIP בעל כתובת ציבורית ויציבה, נגיש מרשת ימות, עם RTP פתוח ומוגבל ברמת firewall.
2. מקור שידור אינטרנטי רשמי/מורשה לכל ערוץ עם הרשאת העברה למאזיני הקו. אין להניח שכתובת אתר צפייה היא כתובת מדיה; אין לעקוף DRM או בקרות גישה.
3. הפעלת FFmpeg בשרת SIP (לא על מחשב המשתמש), וניטור/חידוש אוטומטי של הזרמת השמע במקרה ניתוק.
4. **בדיקת שיחת טלפון אמיתית** לכל אחד מששת הערוצים, בדיקת איכות, השהיה והחזרה לתפריט.

### משתני סביבה (בשרת Node)
```ini
BRANCH2_LIVE_TV_ENABLED=false
BRANCH2_TV_KAN11_SIP=tv1@your-sip-host.example
BRANCH2_TV_12_SIP=tv2@your-sip-host.example
BRANCH2_TV_13_SIP=tv3@your-sip-host.example
BRANCH2_TV_14_SIP=tv4@your-sip-host.example
BRANCH2_TV_I24_SIP=tv5@your-sip-host.example
BRANCH2_TV_KNESSET_SIP=tv6@your-sip-host.example
```

Replace example placeholders only after the SIP service has been tested. Set
`BRANCH2_LIVE_TV_ENABLED=true` **only then**. The app provisions `/2/8`
and `/2/8/1..6` independently. It does not change the existing `/2` YouTube
search engine or reenable the cancelled `/5`.

### Server example: Asterisk

Below is illustrative, *not* a ready production installation. Run FFmpeg as
an external audio source for Asterisk (custom MOH source on **Asterisk**, not Yemot).
Make a separate class per permitted media feed; each class is sourced by a command
using `ffmpeg -re -i <AUTHORIZED_FEED_URL> -vn -ac 1 -ar 8000 -f s16le pipe:1`.
Configure the SIP dialplan to answer the six SIP users and play the matching
Asterisk media class until hangup. Protect SIP ingress from untrusted calls,
limit concurrency and reconnect failed FFmpeg processes. Keep feed URLs and tokens
in server secrets, never in GitHub.

**No test stream URLs or SIP credentials are configured here.** The user must not
be told playback works until the server has valid feeds, routes and an actual
telephone test passes.
