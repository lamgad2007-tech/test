const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const axios = require('axios');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// تقديم ملفات الواجهة الأمامية
app.use(express.static(path.join(__dirname, 'public')));

// إعدادات API - استبدل النص أدناه بمفتاحك الخاص
const API_KEY = 'e765dc398b8147fc94fbcb3cc46c649e'; 
let currentLeague = 'PL'; // الدوري الافتراضي: الإنجليزي

let matches = [];

io.on('connection', (socket) => {
    console.log('مستخدم جديد اتصل:', socket.id);

    // إرسال البيانات الحالية فور الاتصال
    socket.emit('updateMatches', matches);

    socket.on('disconnect', () => {
        console.log('مستخدم غادر');
    });

    // الاستماع لحدث تغيير الدوري من العميل
    socket.on('change_league', (leagueCode) => {
        console.log(`طلب تغيير الدوري إلى: ${leagueCode}`);
        const allowedLeagues = ['ALL', 'PL', 'PD', 'BL1', 'FL1', 'SA', 'CL', 'ELC', 'DED', 'PPL', 'BSA'];
        if (allowedLeagues.includes(leagueCode)) {
            // تحديث رابط الـ API
            currentLeague = leagueCode;
            
            // إيقاف التحديث الدوري القديم
            clearInterval(fetchInterval);
            // جلب البيانات الجديدة فوراً
            fetchLiveMatches();
            // بدء تحديث دوري جديد
            fetchInterval = setInterval(fetchLiveMatches, 60000);
        }
    });

    // الاستماع لطلب ترتيب الدوري
    socket.on('get_standings', async (leagueCode) => {
        console.log(`طلب ترتيب الدوري: ${leagueCode}`);
        try {
            const url = `https://api.football-data.org/v4/competitions/${leagueCode}/standings`;
            const response = await axios.get(url, {
                headers: { 'X-Auth-Token': API_KEY }
            });

            // standings[0] عادة يحتوي على الترتيب الكلي (Total)
            let table = response.data.standings[0].table;

            // إضافة مؤشر تغير المركز (محاكاة لغرض العرض)
            table = table.map(row => {
                // توليد قيمة عشوائية (-1: هبوط، 0: ثبات، 1: صعود) بناءً على معرف الفريق لضمان الثبات النسبي
                const trend = (row.team.id % 3) - 1; 
                return { ...row, trend };
            });

            socket.emit('standings_response', table);
        } catch (error) {
            console.error('Error fetching standings:', error.message);
        }
    });

    // الاستماع لطلب قائمة الهدافين
    socket.on('get_top_scorers', async (leagueCode) => {
        console.log(`طلب قائمة الهدافين: ${leagueCode}`);
        try {
            const url = `https://api.football-data.org/v4/competitions/${leagueCode}/scorers`;
            const response = await axios.get(url, {
                headers: { 'X-Auth-Token': API_KEY }
            });

            socket.emit('top_scorers_response', response.data.scorers);
        } catch (error) {
            console.error('Error fetching top scorers:', error.message);
        }
    });

    // الاستماع لطلب تفاصيل لاعب
    socket.on('get_player_details', async (playerId) => {
        console.log(`طلب تفاصيل اللاعب: ${playerId}`);
        try {
            const url = `https://api.football-data.org/v4/persons/${playerId}`;
            const response = await axios.get(url, {
                headers: { 'X-Auth-Token': API_KEY }
            });
            socket.emit('player_details_response', response.data);
        } catch (error) {
            console.error('Error fetching player details:', error.message);
        }
    });

    // الاستماع لطلب البحث عن فريق (Global Search)
    socket.on('search_team', async (query) => {
        console.log(`بحث عن فريق: ${query}`);
        try {
            // ملاحظة: قد تكون هذه الميزة محدودة في الباقة المجانية لبعض الدوريات
            // نستخدم TLA (الرمز الثلاثي) أو الاسم للبحث
            const url = `https://api.football-data.org/v4/teams?name=${encodeURIComponent(query)}`;
            const response = await axios.get(url, {
                headers: { 'X-Auth-Token': API_KEY }
            });

            socket.emit('search_team_results', response.data.teams);
        } catch (error) {
            console.error('Error searching team:', error.message);
        }
    });

    // الاستماع لطلب تفاصيل مباريات فريق معين
    socket.on('get_team_details', async (teamId) => {
        console.log(`طلب سجل مباريات الفريق: ${teamId}`);
        try {
            // جلب مباريات الفريق (الموسم الحالي)
            const url = `https://api.football-data.org/v4/teams/${teamId}/matches?limit=50`;
            const response = await axios.get(url, {
                headers: { 'X-Auth-Token': API_KEY }
            });

            const allMatches = response.data.matches;

            // دالة تنسيق مصغرة
            const formatMatch = (m) => ({
                id: m.id,
                league: m.competition.name,
                home: m.homeTeam.shortName || m.homeTeam.name,
                homeLogo: m.homeTeam.crest,
                away: m.awayTeam.shortName || m.awayTeam.name,
                awayLogo: m.awayTeam.crest,
                homeScore: m.score.fullTime.home ?? 0,
                awayScore: m.score.fullTime.away ?? 0,
                utcDate: m.utcDate,
                status: (m.status === 'IN_PLAY' || m.status === 'PAUSED') ? 'LIVE' : (m.status === 'FINISHED' ? 'FT' : 'SCHEDULED')
            });

            // تصفية المباريات المنتهية (آخر 5)
            const finished = allMatches
                .filter(m => m.status === 'FINISHED')
                .sort((a, b) => new Date(b.utcDate) - new Date(a.utcDate))
                .slice(0, 5);

            // تصفية المباريات القادمة (أقرب 5)
            const upcoming = allMatches
                .filter(m => m.status !== 'FINISHED' && m.status !== 'CANCELED')
                .sort((a, b) => new Date(a.utcDate) - new Date(b.utcDate))
                .slice(0, 5);

            socket.emit('team_details_response', {
                finished: finished.map(formatMatch),
                upcoming: upcoming.map(formatMatch)
            });

        } catch (error) {
            console.error('Error fetching team matches:', error.message);
        }
    });
});

// دالة لجلب المباريات الحقيقية
async function fetchLiveMatches() {
    try {
        // حساب التاريخ (اليوم + 10 أيام قادمة لضمان ظهور المباريات المجدولة القريبة)
        const now = new Date();
        const dateFrom = now.toISOString().split('T')[0];
        
        const futureDate = new Date(now);
        futureDate.setDate(now.getDate() + 3); // جلب مباريات الـ 3 أيام القادمة
        const dateTo = futureDate.toISOString().split('T')[0];

        // بناء الرابط مع فلتر التاريخ (تغيير الرابط إذا كان الطلب لكل الدوريات)
        let url;
        if (currentLeague === 'ALL') {
            url = `https://api.football-data.org/v4/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
        } else {
            url = `https://api.football-data.org/v4/competitions/${currentLeague}/matches?dateFrom=${dateFrom}&dateTo=${dateTo}`;
        }
        
        console.log(`جاري طلب البيانات من: ${url}`);

        const response = await axios.get(url, {
            headers: { 'X-Auth-Token': API_KEY }
        });

        if (response.data.matches.length === 0) {
            matches = [];
            io.emit('updateMatches', matches);
            console.log(`لا توجد مباريات في الفترة المحددة للدوري: ${currentLeague}`);
            return;
        }

        // تحويل البيانات لتناسب الواجهة الأمامية
        matches = response.data.matches.map(match => {
            let status = match.status;
            
            // حساب الدقيقة (تقديري) لأن API المجاني لا يوفرها
            let calculatedMinute = null;
            if (status === 'IN_PLAY' || status === 'PAUSED') {
                const start = new Date(match.utcDate);
                const now = new Date();
                const diff = Math.floor((now - start) / 60000);
                
                if (status === 'PAUSED') {
                    calculatedMinute = 'HT';
                } else {
                    // تقدير الشوط الثاني (بعد 60 دقيقة من البداية نخصم 15 دقيقة استراحة)
                    calculatedMinute = diff > 60 ? diff - 15 : diff;
                    if (calculatedMinute > 90) calculatedMinute = '90+';
                    if (calculatedMinute < 1) calculatedMinute = 1;
                }
            }

            // توحيد مسميات الحالة
            if (status === 'IN_PLAY' || status === 'PAUSED') status = 'LIVE';
            if (status === 'FINISHED') status = 'FT';

            // محاكاة الإحصائيات (لأن API المجاني لا يوفرها في قائمة المباريات)
            // نستخدم ID المباراة لتوليد أرقام شبه ثابتة حتى لا تتغير عشوائياً مع كل تحديث
            let stats = { 
                homePossession: 50, awayPossession: 50, 
                homeShots: 0, awayShots: 0, 
                homeOnTarget: 0, awayOnTarget: 0,
                homeCorners: 0, awayCorners: 0,
                homeOffsides: 0, awayOffsides: 0,
                homeRedCards: 0, awayRedCards: 0,
                homeAttacks: 0, awayAttacks: 0
            };
            
            if (status === 'LIVE' || status === 'FT') {
                const seed = match.id + (match.score.fullTime.home || 0) + (match.score.fullTime.away || 0);
                const pseudoRandom = (x) => ((x * 9301 + 49297) % 233280) / 233280;
                
                const possession = Math.floor(pseudoRandom(seed) * 40) + 30; // بين 30 و 70
                stats.homePossession = possession;
                stats.awayPossession = 100 - possession;
                stats.homeShots = Math.floor(pseudoRandom(seed + 1) * 15) + 2;
                stats.awayShots = Math.floor(pseudoRandom(seed + 2) * 15) + 2;
                stats.homeOnTarget = Math.floor(stats.homeShots * 0.6);
                stats.awayOnTarget = Math.floor(stats.awayShots * 0.6);

                // إحصائيات إضافية
                stats.homeCorners = Math.floor(pseudoRandom(seed + 3) * 12);
                stats.awayCorners = Math.floor(pseudoRandom(seed + 4) * 12);
                stats.homeOffsides = Math.floor(pseudoRandom(seed + 5) * 6);
                stats.awayOffsides = Math.floor(pseudoRandom(seed + 6) * 6);
                stats.homeRedCards = pseudoRandom(seed + 7) > 0.95 ? 1 : 0;
                stats.awayRedCards = pseudoRandom(seed + 8) > 0.95 ? 1 : 0;
                stats.homeAttacks = stats.homeShots * 3 + Math.floor(pseudoRandom(seed + 9) * 30);
                stats.awayAttacks = stats.awayShots * 3 + Math.floor(pseudoRandom(seed + 10) * 30);
            }

            // محاكاة دليل اللياقة (Form Guide) - آخر 5 مباريات
            // W: فوز (أخضر)، D: تعادل (رمادي)، L: خسارة (أحمر)
            const generateForm = (id) => {
                const results = ['W', 'D', 'L', 'W', 'W', 'L', 'D'];
                let form = [];
                for(let i=0; i<5; i++) {
                    form.push(results[(id + i) % results.length]);
                }
                return form;
            };
            const homeForm = generateForm(match.homeTeam.id);
            const awayForm = generateForm(match.awayTeam.id);

            // محاكاة احتمالات الفوز (Win Probability)
            const seedProb = match.id;
            let hProb = Math.floor(((seedProb * 123) % 40) + 30); // 30-70%
            let dProb = Math.floor(((seedProb * 321) % 20) + 10); // 10-30%
            let aProb = 100 - hProb - dProb;
            
            // محاكاة شريط الزخم (Momentum) للمباريات المباشرة
            let momentum = { home: 50, away: 50 };
            if (status === 'LIVE') {
                // استخدام الوقت الحالي كجزء من البذرة لجعله يتغير مع كل تحديث
                const timeSeed = Math.floor(Date.now() / 60000); // يتغير كل دقيقة
                const seed = match.id + timeSeed;
                const pseudoRandom = (x) => ((x * 9301 + 49297) % 233280) / 233280;
                
                const homeMomentum = Math.floor(pseudoRandom(seed) * 60) + 20; // قيمة بين 20 و 80
                momentum.home = homeMomentum;
                momentum.away = 100 - homeMomentum;
            }

            // محاكاة أحداث المباراة (Timeline) - مستوحاة من 365scores
            let events = [];
            if (status === 'LIVE' || status === 'FT') {
                const seed = match.id;
                const pseudoRandom = (x) => ((x * 9301 + 49297) % 233280) / 233280;
                
                // توليد أهداف الفريق المضيف
                for (let i = 0; i < (match.score.fullTime.home || 0); i++) {
                    const minute = Math.floor(pseudoRandom(seed + i) * 90) + 1;
                    events.push({ type: 'Goal', team: 'home', minute: minute, player: 'Player ' + (i+1) });
                }
                
                // توليد أهداف الفريق الضيف
                for (let i = 0; i < (match.score.fullTime.away || 0); i++) {
                    const minute = Math.floor(pseudoRandom(seed + i + 100) * 90) + 1;
                    events.push({ type: 'Goal', team: 'away', minute: minute, player: 'Player ' + (i+1) });
                }

                // إضافة بطاقات عشوائية (لإعطاء طابع واقعي)
                const cardsCount = Math.floor(pseudoRandom(seed + 50) * 4);
                for (let i = 0; i < cardsCount; i++) {
                    const minute = Math.floor(pseudoRandom(seed + i + 200) * 90) + 1;
                    const isHome = pseudoRandom(seed + i + 300) > 0.5;
                    const cardType = pseudoRandom(seed + i + 400) > 0.9 ? 'Red' : 'Yellow';
                    events.push({ 
                        type: 'Card', 
                        detail: cardType, 
                        team: isHome ? 'home' : 'away', 
                        minute: minute, 
                        player: isHome ? 'Home Player' : 'Away Player' 
                    });
                }

                // ترتيب الأحداث زمنياً
                events.sort((a, b) => a.minute - b.minute);
            }

            // محاكاة التعليق المباشر (Live Commentary)
            let commentary = [];
            if (status === 'LIVE' || status === 'FT') {
                const seed = match.id;
                const pseudoRandom = (x) => ((x * 9301 + 49297) % 233280) / 233280;

                // إضافة تعليقات من الأحداث الرئيسية
                events.forEach(event => {
                    const teamName = event.team === 'home' ? (match.homeTeam.shortName || match.homeTeam.name) : (match.awayTeam.shortName || match.awayTeam.name);
                    let text = '';
                    if (event.type === 'Goal') {
                        text = `جوووول! ${event.player} يسجل لصالح ${teamName}! النتيجة الآن ${match.score.fullTime.home} - ${match.score.fullTime.away}.`;
                    } else if (event.type === 'Card') {
                        text = `بطاقة ${event.detail === 'Yellow' ? 'صفراء' : 'حمراء'}! الحكم يشهر البطاقة في وجه ${event.player} من فريق ${teamName}.`;
                    }
                    if (text) commentary.push({ minute: event.minute, text, type: event.type, detail: event.detail });
                });

                // إضافة تعليقات عامة للمباريات المباشرة
                const endMinute = status === 'LIVE' && calculatedMinute !== 'HT' && calculatedMinute !== '90+' ? calculatedMinute : 90;
                for (let min = 1; min <= endMinute; min++) {
                    // التأكد من عدم وجود حدث رئيسي في هذه الدقيقة
                    if (!events.some(e => e.minute === min)) {
                        if (pseudoRandom(seed + min) > 0.9) { // فرصة 10% لإضافة تعليق عام
                            const attackingTeam = pseudoRandom(seed + min + 1) > 0.5 ? (match.homeTeam.shortName || match.homeTeam.name) : (match.awayTeam.shortName || match.awayTeam.name);
                            const comments = [
                                `هجمة منظمة لفريق ${attackingTeam}.`, `سيطرة واستحواذ على الكرة في وسط الملعب من جانب ${attackingTeam}.`, `تسديدة قوية من خارج منطقة الجزاء ولكنها تمر بجوار القائم.`, `الدفاع يشتت الكرة ويبعد الخطورة.`, `رمية تماس لصالح ${attackingTeam} في مكان جيد.`, `ضربة ركنية، هل ستشكل خطورة؟`
                            ];
                            commentary.push({ minute: min, text: comments[Math.floor(pseudoRandom(seed + min + 2) * comments.length)], type: 'General' });
                        }
                    }
                }

                commentary.sort((a, b) => a.minute - b.minute);
            }

            // محاكاة التشكيلة (Lineups)
            let lineups = { home: [], away: [] };
            if (status === 'LIVE' || status === 'FT') {
                // قاعدة بيانات مصغرة لتشكيلات الأندية الكبرى
                const realSquads = {
                    // الدوري الإنجليزي
                    "Man City": ["Ederson", "Walker", "Dias", "Akanji", "Gvardiol", "Rodri", "De Bruyne", "Bernardo", "Foden", "Haaland", "Doku"],
                    "Arsenal": ["Raya", "White", "Saliba", "Gabriel", "Zinchenko", "Rice", "Odegaard", "Havertz", "Saka", "Jesus", "Martinelli"],
                    "Liverpool": ["Alisson", "Trent", "Van Dijk", "Konate", "Robertson", "Mac Allister", "Szoboszlai", "Jones", "Salah", "Nunez", "Diaz"],
                    "Man United": ["Onana", "Dalot", "Varane", "Martinez", "Shaw", "Casemiro", "Mainoo", "Fernandes", "Garnacho", "Hojlund", "Rashford"],
                    "Chelsea": ["Petrovic", "Gusto", "Disasi", "Colwill", "Chilwell", "Caicedo", "Enzo", "Gallagher", "Palmer", "Jackson", "Sterling"],
                    "Tottenham": ["Vicario", "Porro", "Romero", "Van de Ven", "Udogie", "Bissouma", "Sarr", "Maddison", "Kulusevski", "Richarlison", "Son"],
                    "Newcastle": ["Pope", "Trippier", "Schar", "Botman", "Burn", "Guimaraes", "Longstaff", "Joelinton", "Almiron", "Isak", "Gordon"],
                    
                    // الدوري الإسباني
                    "Real Madrid": ["Lunin", "Carvajal", "Rudiger", "Nacho", "Mendy", "Tchouameni", "Kroos", "Valverde", "Bellingham", "Rodrygo", "Vinicius"],
                    "Barcelona": ["Ter Stegen", "Kounde", "Araujo", "Cubarsi", "Cancelo", "Christensen", "Gundogan", "Pedri", "Yamal", "Lewandowski", "Raphinha"],
                    "Atleti": ["Oblak", "Molina", "Witsel", "Gimenez", "Hermoso", "Lino", "De Paul", "Koke", "Llorente", "Griezmann", "Morata"],

                    // الدوري الإيطالي
                    "Juventus": ["Szczesny", "Gatti", "Bremer", "Danilo", "Cambiaso", "McKennie", "Locatelli", "Rabiot", "Kostic", "Vlahovic", "Chiesa"],
                    "Milan": ["Maignan", "Calabria", "Thiaw", "Tomori", "Hernandez", "Bennacer", "Reijnders", "Pulisic", "Loftus-Cheek", "Leao", "Giroud"],
                    "Inter": ["Sommer", "Pavard", "Acerbi", "Bastoni", "Darmian", "Barella", "Calhanoglu", "Mkhitaryan", "Dimarco", "Thuram", "Martinez"],

                    // الدوري الألماني والفرنسي
                    "Bayern": ["Neuer", "Kimmich", "De Ligt", "Dier", "Davies", "Goretzka", "Laimer", "Sane", "Muller", "Musiala", "Kane"],
                    "Dortmund": ["Kobel", "Ryerson", "Hummels", "Schlotterbeck", "Maatsen", "Sabitzer", "Can", "Sancho", "Brandt", "Adeyemi", "Fullkrug"],
                    "Leverkusen": ["Hradecky", "Stanisic", "Tah", "Tapsoba", "Frimpong", "Xhaka", "Palacios", "Grimaldo", "Wirtz", "Adli", "Schick"],
                    "PSG": ["Donnarumma", "Hakimi", "Marquinhos", "Hernandez", "Mendes", "Zaire-Emery", "Vitinha", "Ruiz", "Dembele", "Mbappe", "Barcola"]
                };

                // قائمة احتياطية للفرق غير المعروفة
                const fallbackPlayers = ["Goalkeeper", "Defender 1", "Defender 2", "Defender 3", "Defender 4", "Midfielder 1", "Midfielder 2", "Midfielder 3", "Winger 1", "Striker", "Winger 2"];

                const getSquad = (teamName) => {
                    if (!teamName) return fallbackPlayers;
                    // البحث عن اسم الفريق في القائمة (بحث ذكي)
                    for (const [key, squad] of Object.entries(realSquads)) {
                        if (teamName.includes(key) || (key === "Barça" && teamName.includes("Barcelona"))) {
                            return squad;
                        }
                    }
                    return fallbackPlayers;
                };

                const homeSquad = getSquad(match.homeTeam.shortName || match.homeTeam.name);
                const awaySquad = getSquad(match.awayTeam.shortName || match.awayTeam.name);

                const getPlayer = (squad, teamSeed, num, pos) => {
                    const seed = match.id + teamSeed + num;
                    // اختيار لاعب من القائمة الخاصة بالفريق
                    const nameIndex = seed % squad.length;
                    const name = squad[nameIndex];
                    // استخدام صور أشخاص حقيقيين (عشوائية) بدلاً من الرموز لزيادة الواقعية
                    const photoIndex = seed % 99; // اختيار صورة عشوائية من 0 إلى 99
                    return { name: name, number: num, pos, photo: `https://randomuser.me/api/portraits/men/${photoIndex}.jpg` };
                };

                // تشكيلة بسيطة 4-4-2
                lineups.home = [
                    getPlayer(homeSquad, 100, 1, 'GK'),
                    getPlayer(homeSquad, 100, 2, 'DF'), getPlayer(homeSquad, 100, 3, 'DF'), getPlayer(homeSquad, 100, 4, 'DF'), getPlayer(homeSquad, 100, 5, 'DF'),
                    getPlayer(homeSquad, 100, 8, 'MF'), getPlayer(homeSquad, 100, 6, 'MF'), getPlayer(homeSquad, 100, 10, 'MF'), getPlayer(homeSquad, 100, 7, 'MF'),
                    getPlayer(homeSquad, 100, 9, 'FW'), getPlayer(homeSquad, 100, 11, 'FW')
                ];
                lineups.away = [
                    getPlayer(awaySquad, 200, 1, 'GK'),
                    getPlayer(awaySquad, 200, 2, 'DF'), getPlayer(awaySquad, 200, 3, 'DF'), getPlayer(awaySquad, 200, 4, 'DF'), getPlayer(awaySquad, 200, 5, 'DF'),
                    getPlayer(awaySquad, 200, 8, 'MF'), getPlayer(awaySquad, 200, 6, 'MF'), getPlayer(awaySquad, 200, 10, 'MF'), getPlayer(awaySquad, 200, 7, 'MF'),
                    getPlayer(awaySquad, 200, 9, 'FW'), getPlayer(awaySquad, 200, 11, 'FW')
                ];
            }

            return {
                id: match.id,
                league: match.competition.name,
                home: match.homeTeam.shortName || match.homeTeam.name,
                homeTeamId: match.homeTeam.id,
                homeLogo: match.homeTeam.crest,
                away: match.awayTeam.shortName || match.awayTeam.name,
                awayTeamId: match.awayTeam.id,
                awayLogo: match.awayTeam.crest,
                homeScore: match.score.fullTime.home ?? 0,
                awayScore: match.score.fullTime.away ?? 0,
                utcDate: match.utcDate,
                statistics: stats,
                lineups: lineups,
                events: events, // إضافة الأحداث
                form: { home: homeForm, away: awayForm }, // إضافة اللياقة
                probabilities: { home: hProb, draw: dProb, away: aProb }, // إضافة الاحتمالات
                commentary: commentary, // إضافة التعليق المباشر
                momentum: momentum, // إضافة الزخم
                minute: calculatedMinute,
                time: status === 'LIVE' ? 'Live' : (new Date(match.utcDate).toLocaleTimeString('en-US', {hour: '2-digit', minute:'2-digit', timeZone: 'UTC'})), 
                status: status
            };
        });

        io.emit('updateMatches', matches);
        console.log(`تم تحديث ${matches.length} مباراة من المصدر`);
    } catch (error) {
        console.error('فشل جلب البيانات:', error.message);
        if (error.response) console.error('تفاصيل الخطأ:', error.response.data);
    }
}

// تحديث البيانات كل 60 ثانية (لتجنب الحظر من النسخة المجانية)
let fetchInterval;
fetchLiveMatches();
fetchInterval = setInterval(fetchLiveMatches, 60000);

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
    console.log(">>> تم تفعيل النسخة الجديدة: لا توجد مباريات وهمية <<<");
});
