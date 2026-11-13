package com.banzou.ktv

import android.content.Context
import java.util.Locale

/**
 * 界面上的全部文字：三种语言一张表（和设计稿 v6 的 strings.js 同一套键和说法）。
 * 每条：[简体, 繁體（台湾用语）, English]。歌名、歌手是数据，不在这里，也不翻译。
 */
object L {
    const val AUTO = "auto"
    const val HANS = "zh-Hans"
    const val HANT = "zh-Hant"
    const val EN = "en"
    val MODES = listOf(AUTO, HANS, HANT, EN)
    /** 语言名永远用它自己的写法 */
    val NAMES = mapOf(HANS to "简体中文", HANT to "繁體中文", EN to "English")

    /** 用户选的：跟随系统 / 简体 / 繁體 / English */
    var mode = AUTO
        private set
    /** 实际用的那一列：0 简体，1 繁體，2 English */
    private var col = 0

    fun load(ctx: Context) {
        val saved = ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).getString("lang", AUTO) ?: AUTO
        mode = if (saved in MODES) saved else AUTO
        resolve(ctx)
    }

    fun set(ctx: Context, m: String) {
        mode = if (m in MODES) m else AUTO
        ctx.getSharedPreferences("ui", Context.MODE_PRIVATE).edit().putString("lang", mode).apply()
        resolve(ctx)
    }

    /** 跟随系统：台、港、澳 → 繁體，其它中文 → 简体，其余 → English */
    @Suppress("DEPRECATION")
    private fun resolve(ctx: Context) {
        col = when (mode) {
            HANS -> 0
            HANT -> 1
            EN -> 2
            else -> {
                val loc: Locale = ctx.resources.configuration.locale ?: Locale.getDefault()
                if (loc.language == "zh") {
                    val region = loc.country.uppercase(Locale.ROOT)
                    if (region == "TW" || region == "HK" || region == "MO" || loc.script.equals("Hant", ignoreCase = true)) 1 else 0
                } else 2
            }
        }
    }

    val isEnglish get() = col == 2

    fun t(key: String): String = table[key]?.get(col) ?: key

    /** 带变量的句子：t("tPicked", "t" to 歌名) */
    fun t(key: String, vararg vars: Pair<String, Any?>): String {
        var s = t(key)
        for ((k, v) in vars) s = s.replace("{$k}", v?.toString() ?: "")
        return s
    }

    private val table: Map<String, Array<String>> = mapOf(
        "language" to arrayOf("语言", "語言", "Language"),
        "followSystem" to arrayOf("跟随系统", "跟隨系統", "System default"),
        "tagPicked" to arrayOf("已点", "已點", "Queued"),
        "tagSending" to arrayOf("传送中", "傳送中", "Transferring"),
        "tagOnPc" to arrayOf("在电脑上", "在電腦上", "On computer"),
        "queue" to arrayOf("已点", "已點", "Queue"),
        "queueEmpty" to arrayOf("还没点歌", "尚未點歌", "The queue is empty"),
        "nowSinging" to arrayOf("正在唱", "正在唱", "Now singing"),
        "music" to arrayOf("伴奏", "伴奏", "Music"),
        "vocalOn" to arrayOf("原唱", "原唱", "Vocals on"),
        "vocalOff" to arrayOf("伴唱", "伴唱", "Vocals off"),
        "restart" to arrayOf("重唱", "重唱", "Restart"),
        "skip" to arrayOf("切歌", "切歌", "Skip"),
        "next" to arrayOf("下一首", "下一首", "Next"),
        "songsCount" to arrayOf("{n} 首歌", "{n} 首歌曲", "{n} songs"),
        "phoneChip" to arrayOf("手机点歌", "手機點歌", "Phone remote"),
        "qrTitle" to arrayOf("用手机扫一扫", "用手機掃一掃", "Scan with your phone"),
        "qrSub" to arrayOf("打开手机相机，对准左边的二维码，就能在手机上点歌、切歌、调音量。", "開啟手機相機，對準左邊的 QR Code，即可在手機上點歌、切歌、調整音量。", "Point your phone camera at the code to pick songs, skip and set the volume."),
        "qrWifi" to arrayOf("手机和电视要在同一个 Wi-Fi。", "手機與電視須使用同一個 Wi-Fi。", "Phone and TV must be on the same Wi-Fi."),
        "qrFallback" to arrayOf("扫不了，就在手机浏览器里打开", "無法掃描時，請以手機瀏覽器開啟", "Can’t scan? Open this in your phone’s browser"),
        "qrNoNet" to arrayOf("电视还没连上网络", "電視尚未連上網路", "The TV isn’t on a network yet"),
        "emptyPhone" to arrayOf("按确认键，用手机扫码点歌", "按確認鍵，以手機掃碼點歌", "Press OK to scan the code and use your phone"),
        "tPhoneJoined" to arrayOf("手机连上了", "手機已連線", "Phone connected"),
        "phoneHint" to arrayOf("手机点歌　浏览器打开", "手機點歌　以瀏覽器開啟", "Phone remote · open in a browser"),
        "searchHint" to arrayOf("按首字母搜歌名、歌手", "以拼音首字母搜尋歌名、歌手", "Search by initials"),
        "allSongs" to arrayOf("全部歌曲", "全部歌曲", "All songs"),
        "found" to arrayOf("找到 {n} 首", "找到 {n} 首", "{n} found"),
        "noMatch" to arrayOf("没找到「{q}」", "找不到「{q}」", "Nothing for “{q}”"),
        "noMatchHint" to arrayOf("按返回键删一个字母", "按返回鍵刪一個字母", "Press Back to delete a letter"),
        "keyDel" to arrayOf("删", "刪", "Delete"),
        "keyClear" to arrayOf("清空", "清空", "Clear"),
        "nowSingingT" to arrayOf("正在唱：{t}", "正在唱：{t}", "Now singing: {t}"),
        "waitingFor" to arrayOf("等电脑传「{t}」", "等候電腦傳送「{t}」", "Transferring “{t}”"),
        "preview" to arrayOf("副歌试听", "副歌試聽", "Preview"),
        "noPreviewSinging" to arrayOf("唱歌的时候不放试听", "演唱時不播放試聽", "No previews while singing"),
        "noPreview1" to arrayOf("这首还没有试听", "這首尚無試聽", "No preview yet"),
        "noPreview2" to arrayOf("在电脑上点「更新电视歌单」", "在電腦上按「更新電視歌單」", "Choose “Update TV list” on the computer"),
        "kOk" to arrayOf("确认", "確認", "OK"),
        "kBack" to arrayOf("返回", "返回", "Back"),
        "kMenu" to arrayOf("菜单", "選單", "Menu"),
        "hPick" to arrayOf("点歌", "點歌", "Select"),
        "hType" to arrayOf("输入", "輸入", "Type"),
        "hDelLetter" to arrayOf("删一个字母", "刪一個字母", "Delete a letter"),
        "hTop" to arrayOf("置顶", "置頂", "Move to top"),
        "hRemove" to arrayOf("删除", "刪除", "Remove"),
        "hBackMv" to arrayOf("回到 MV", "回到 MV", "Back to MV"),
        "hChoose" to arrayOf("选这个", "選擇", "Choose"),
        "hClose" to arrayOf("关掉", "關閉", "Close"),
        "tPicked" to arrayOf("已点：{t}", "已點：{t}", "Queued: {t}"),
        "tSendingSub" to arrayOf("正在从电脑传过来（电脑上的「波点」要开着）", "正在從電腦傳送（電腦上的「波點」需保持開啟）", "Transferring from the computer (keep 波点 open there)"),
        "tAlready" to arrayOf("「{t}」已经点过了", "「{t}」已在清單中", "“{t}” is already in the queue"),
        "tTopped" to arrayOf("已置顶", "已置頂", "Moved to top"),
        "tRemoved" to arrayOf("已删除：{t}", "已刪除：{t}", "Removed: {t}"),
        "tFail" to arrayOf("「{t}」没传过来", "「{t}」未能傳送", "“{t}” could not be transferred"),
        "tFailSub" to arrayOf("电脑上的「波点」没开着，打开以后再点一次", "電腦上的「波點」尚未開啟，開啟後請再點一次", "Open 波点 on the computer, then select it again"),
        "tArrived" to arrayOf("电脑传好了一首，可以唱了", "已收到一首，可以唱了", "A song has arrived"),
        "nextT" to arrayOf("下一首：{t}", "下一首：{t}", "Next: {t}"),
        "lyricist" to arrayOf("作词", "作詞", "Lyrics"),
        "composer" to arrayOf("作曲", "作曲", "Music"),
        "paused" to arrayOf("暂停", "暫停", "Paused"),
        "resume" to arrayOf("继续", "繼續", "Resume"),
        "padVocal" to arrayOf("原唱 / 伴唱", "原唱 / 伴唱", "Vocals on / off"),
        "padLyrics" to arrayOf("歌词开 / 关", "歌詞開 / 關", "Lyrics on / off"),
        "goPick" to arrayOf("去点歌", "前往點歌", "Song list"),
        "cantPlay" to arrayOf("「{t}」放不了", "「{t}」無法播放", "“{t}” can’t be played"),
        "skipping" to arrayOf("跳到下一首", "播放下一首", "Moving to the next song"),
        "noSongs" to arrayOf("还没有歌", "還沒有歌", "No songs yet"),
        "emptyHow" to arrayOf("在电脑的{app}里点{btn}，歌就传过来了", "在電腦的{app}中按下{btn}，歌曲便會傳送過來", "On your computer, open {app} and choose {btn}"),
        "appName" to arrayOf("波点", "波點", "波点"),
        "tvBtn" to arrayOf("电视", "電視", "TV"),
        "rTitle" to arrayOf("波点 遥控", "波點 遙控", "波点 Remote"),
        "rOffline" to arrayOf("连不上电视：电视要开着并打开「波点」，手机和电视要在同一个网络。", "無法連接電視：請確認電視已開啟「波點」，且手機與電視使用同一個網路。", "Can’t reach the TV. Open 波点 on the TV and join the same Wi-Fi."),
        "rNotSinging" to arrayOf("还没在唱", "尚未開始", "Nothing playing"),
        "rIdleNext" to arrayOf("去「点歌」里点一首", "到「點歌」選一首", "Choose a song under Songs"),
        "pause" to arrayOf("暂停", "暫停", "Pause"),
        "segVocalOn" to arrayOf("原唱", "原唱", "Vocals"),
        "segVocalOff" to arrayOf("伴唱", "伴唱", "Off"),
        "segLyricsOn" to arrayOf("歌词开", "歌詞開", "Lyrics"),
        "segLyricsOff" to arrayOf("关", "關", "Off"),
        "rOpenPick" to arrayOf("在电视上打开点歌", "在電視上開啟點歌", "Show the song list on TV"),
        "volume" to arrayOf("音量", "音量", "Volume"),
        "vocal" to arrayOf("人声", "人聲", "Vocals"),
        "rVocalHint" to arrayOf("人声就是原唱的声音。拉到 0 是伴唱，拉一点点可以当「导唱」跟着唱。", "人聲即原唱的聲音。調到 0 為伴唱，稍微調高可作為「導唱」跟著唱。", "Vocals is the original singer. At 0 it is pure karaoke; a little helps you follow along."),
        "lyricTiming" to arrayOf("歌词时间", "歌詞時間", "Lyric timing"),
        "earlier" to arrayOf("早一点", "早一點", "Earlier"),
        "later" to arrayOf("晚一点", "晚一點", "Later"),
        "onTime" to arrayOf("准时", "準時", "On time"),
        "rTimingHint" to arrayOf("接蓝牙音箱时声音会晚一点。歌词变色比歌声早，就点「晚一点」。", "連接藍牙喇叭時聲音會稍慢。若歌詞變色比歌聲早，請按「晚一點」。", "Bluetooth speakers add a slight delay. If the lyrics change colour before the singing, tap Later."),
        "library" to arrayOf("曲库", "全部歌曲", "All songs"),
        "rSearchPh" to arrayOf("搜歌名、歌手，或者首字母（JMXS）", "搜尋歌名、歌手，或拼音首字母", "Title, artist or initials (TD)"),
        "rOnPc" to arrayOf("在电脑上，点了会传过来", "在電腦上，點選後傳送", "Transfers from computer"),
        "rPick" to arrayOf("点歌", "點歌", "Select"),
        "rSing" to arrayOf("唱", "唱", "Sing"),
        "rSinging" to arrayOf("正在唱", "正在唱", "Singing"),
        "rTop" to arrayOf("置顶", "置頂", "Move to top"),
        "rDel" to arrayOf("删", "刪", "Remove"),
        "tabRemote" to arrayOf("遥控", "遙控", "Remote"),
        "tabSongs" to arrayOf("点歌", "點歌", "Songs"),
        "brand" to arrayOf("波点", "波點", "波点"),
        "brandLatin" to arrayOf("BODIAN", "BODIAN", "BODIAN"),
        "introSkip" to arrayOf("按任意键跳过", "按任意鍵跳過", "Press any key to skip"),
        "tReqFailSub" to arrayOf("在电脑上用「电视」把这首传过来", "在電腦上用「電視」把這首傳過來", "Send it from the computer’s TV window instead"),
        "tReqFail" to arrayOf("没法通知电脑传「{t}」", "無法通知電腦傳「{t}」", "Couldn't ask the computer for “{t}”"),
        "tNoVocal" to arrayOf("这首没有原唱", "這首沒有原唱", "This song has no vocal track"),
        "lyricsOn" to arrayOf("歌词：开", "歌詞：開", "Lyrics on"),
        "lyricsOff" to arrayOf("歌词：关", "歌詞：關", "Lyrics off"),
        "offOnTime" to arrayOf("歌词：准时", "歌詞：準時", "Lyrics: on time"),
        "offLate" to arrayOf("歌词晚 {n} 毫秒", "歌詞晚 {n} 毫秒", "Lyrics {n} ms later"),
        "offEarly" to arrayOf("歌词早 {n} 毫秒", "歌詞早 {n} 毫秒", "Lyrics {n} ms earlier"),
        "thisSong" to arrayOf("这首", "這首", "This song"),
        // v9：标签筛选、我的歌单（和设计稿 strings-v9.js 同一套键）
        "fAll" to arrayOf("全部", "全部", "All"),
        "fFav" to arrayOf("常点", "常點", "Favorites"),
        "fZh" to arrayOf("国语", "國語", "Mandarin"),
        "fYue" to arrayOf("粤语", "粵語", "Cantonese"),
        "fEn" to arrayOf("英文", "英文", "English"),
        "fJk" to arrayOf("日韩", "日韓", "JP / KR"),
        "fOther" to arrayOf("其他", "其他", "Other"),
        "fDecade" to arrayOf("年代", "年代", "Decade"),
        "fEarlier" to arrayOf("更早", "更早", "Earlier"),
        "fArtist" to arrayOf("歌手", "歌手", "Artist"),
        "myLists" to arrayOf("我的歌单", "我的歌單", "Playlists"),
        "hFilter" to arrayOf("筛选", "篩選", "Filter"),
        "hClearFilter" to arrayOf("看全部", "看全部", "Show all"),
        "hOpen" to arrayOf("打开", "開啟", "Open"),
        "noLists" to arrayOf("还没有歌单", "還沒有歌單", "No playlists yet"),
        "noListsHow" to arrayOf("在电脑的「{app}」里建歌单", "在電腦的「{app}」中建立歌單", "Create one in {app} on your computer"),
        "listEmpty" to arrayOf("这张歌单还是空的", "這張歌單還是空的", "This playlist is empty"),
    )
}
