# 豆包语音播客 API 契约（抓取存档）

> **来源**：https://docs.volcengine.com/docs/DoubaoVoice/PodcastAPI-websocket-v3protocol?lang=zh
> **抓取方式**：该站是客户端渲染，`web_fetch` 只得到空 body。用无头 Edge 渲染后 `--dump-dom` 取完整 DOM
> （363 KB），再由 `tmp/smoke/html-to-text.mjs` 抽成正文。
> **抓取时间**：2026-10-03
>
> 这份是**原文存档**，未经删改。逐行脚本模式（`action: 3`）正是视频工厂要用的：
> 它给逐行可控的双人对谈配音，每行指定说话人。

---
鐏北寮曟搸

鏂囨。涓績

鐏北鏂硅垷 Agent Plan
鐏北鏂硅垷 Coding Plan
鐏北鏂硅垷
鑺傜渷璁″垝
鐏北鏂硅垷 Agent Plan
鐏北鏂硅垷 Coding Plan
鐏北鏂硅垷
鑺傜渷璁″垝

绠€浣?
鏂囨。鎺у埗鍙扮櫥褰曟敞鍐?
鐧诲綍娉ㄥ唽

璞嗗寘璇煶

鏂囨。鎸囧崡浜у搧璁¤垂API鍙傝€?
璞嗗寘璇煶
璞嗗寘璇煶

API鍙傝€?
璇疯緭鍏?
璇煶鍚堟垚澶фā鍨?闊抽鐢熸垚
闊抽鐢熸垚

鍚屾璇煶鍚堟垚
鍗曞悜娴佸紡璇煶鍚堟垚(HTTP)
鍗曞悜娴佸紡璇煶鍚堟垚(WebSocket)
鍙屽悜娴佸紡璇煶鍚堟垚(WebSocket)

寮傛闀挎枃鏈闊冲悎鎴?浠诲姟鎻愪氦
缁撴灉鏌ヨ

澹伴煶澶嶅埢
闊宠壊娉ㄥ唽
闊宠壊鏌ヨ
闊宠壊鍗囩骇

闊宠壊璁捐
闊宠壊璁捐

閿欒鐮佹煡璇?
璇煶璇嗗埆澶фā鍨?娴佸紡璇煶璇嗗埆
涓€鍙ヨ瘽璇嗗埆
瀹炴椂璇煶璇嗗埆

褰曢煶鏂囦欢璇嗗埆
褰曢煶鏂囦欢璇嗗埆鏍囧噯鐗?浠诲姟鎻愪氦
缁撴灉鏌ヨ

褰曢煶鏂囦欢璇嗗埆闂叉椂鐗?浠诲姟鎻愪氦
缁撴灉鏌ヨ

褰曢煶鏂囦欢璇嗗埆鏋侀€熺増

閿欒鐮佹煡璇?
绔埌绔疄鏃惰闊冲ぇ妯″瀷
绔埌绔疄鏃惰闊?
璇煶鎾澶фā鍨?璇煶鎾

璇煶鍚屼紶澶фā鍨?鍚屽０浼犺瘧

鏈哄櫒缈昏瘧澶фā鍨?鏈哄櫒缈昏瘧

Speech SDK
璇煶鍚堟垚澶фā鍨?鍙屽悜娴佸紡璇煶鍚堟垚(iOS)
鍙屽悜娴佸紡璇煶鍚堟垚(Android)

璇煶璇嗗埆澶фā鍨?娴佸紡璇煶璇嗗埆(iOS)
娴佸紡璇煶璇嗗埆(Android)

绔埌绔疄鏃惰闊冲ぇ妯″瀷
瀹炴椂璇煶(Android)
瀹炴椂璇煶(iOS)

鑷涔犲钩鍙?鐑瘝
鐑瘝绠＄悊
鏇挎崲璇?鏇挎崲璇嶇鐞?鏈璇?甯歌闂

鎺у埗鍙扮浉鍏虫帴鍙?API鍙傝€?闊宠壊
澶фā鍨嬮煶鑹插垪琛?
api_key
鑾峰彇APIKey鍒楄〃
鍒涘缓APIKey
鍒犻櫎APIKey
鏇存柊APIKey

service
鑾峰彇鏈嶅姟鐘舵€?鏆傚仠鏈嶅姟
閲嶆柊鍚敤鏈嶅姟
寮€閫氭湇鍔?鍋滅敤鏈嶅姟

resource_packs
杞璧勬簮鍖?鑾峰彇璧勬簮鍖呯姸鎬佷俊鎭?鏇存柊闊宠壊璧勬簮鍒悕
璐拱璧勬簮鍖?
tag
鏌ヨ璧勬簮鎵€闄勫姞鐨勫叏閮ㄦ爣绛?绉婚櫎璧勬簮鏍囩
闄勫姞鏍囩

澹伴煶澶嶅埢
鏌ヨSpeakerID鐘舵€佷俊鎭?鍒嗛〉鏌ヨSpeakerID鐘舵€?闊宠壊涓嬪崟
闊宠壊缁垂
鏌ヨ璐拱闊宠壊

鐩戞帶
Quota鏌ヨ鎺ュ彛
璋冪敤閲忔煡璇㈡帴鍙?
API Key浣跨敤
QPS/骞跺彂鏌ヨ鎺ュ彛璇存槑
璋冪敤閲忔煡璇㈡帴鍙ｈ鏄?
鍘嗗彶鏂囨。
璇煶鍚堟垚鎺ュ彛
WebSocket 鍗曞悜娴佸紡-V3
WebSocket 鍙屽悜娴佸紡-V3
HTTP Chunked/SSE鍗曞悜娴佸紡-V3
澶фā鍨婬TTP闈炴祦寮忔帴鍙?V1
灏忔ā鍨婬TTP闈炴祦寮忔帴鍙?灏忔ā鍨媁ebsocket鎺ュ彛
灏忔ā鍨嬪紓姝ラ暱鏂囨湰鍚堟垚鎺ュ彛
灏忔ā鍨嬮煶鑹插垪琛?
璇煶璇嗗埆鎺ュ彛
褰曢煶鏂囦欢璇嗗埆鏍囧噯鐗圚TTP
褰曢煶鏂囦欢璇嗗埆闂叉椂鐗圚TTP
褰曢煶鏂囦欢鏋侀€熺増璇嗗埆HTTP
涓€鍙ヨ瘽璇嗗埆
娴佸紡璇煶璇嗗埆
褰曢煶鏂囦欢璇嗗埆鏍囧噯鐗?褰曢煶鏂囦欢璇嗗埆鏋侀€熺増
澶фā鍨嬫祦寮忚闊宠瘑鍒獳PI

闊宠棰戝瓧骞曟帴鍙?浜у搧绠€浠?浜у搧姒傝堪
浜у搧浼樺娍
搴旂敤鍦烘櫙

甯歌闂
妯″瀷鏁堟灉FAQ
API鎺ュ叆FAQ
璁¤垂FAQ

闊宠棰戝瓧骞曠敓鎴?鑷姩瀛楀箷鎵撹酱

澹伴煶澶嶅埢鎺ュ彛
澹伴煶澶嶅埢API-V3

SDK鎺ュ叆鏂囨。
绂诲湪绾胯闊冲悎鎴怱DK
SDK姒傝
鍙傛暟璇存槑
閿欒鐮佽鏄?鍙戝竷淇℃伅
璇煶鍚堟垚 SDK 浣跨敤 FAQ
Android
闆嗘垚鎸囧崡
鎺ュ叆娴佺▼
甯歌闂
妯″瀷涓嬪彂
妯″瀷涓嬪彂鎺ュ彛璇存槑锛圴2锛?妯″瀷涓嬪彂鎺ュ彛璇存槑锛圴4锛?
iOS
闆嗘垚鎸囧崡
鎺ュ叆娴佺▼
甯歌闂
妯″瀷涓嬪彂
妯″瀷涓嬪彂鎺ュ彛璇存槑锛圴2锛?妯″瀷涓嬪彂鎺ュ彛璇存槑锛圴4锛?
鐩稿叧鍗忚
璇煶鍚堟垚SDK闅愮鏀跨瓥
璇煶鍚堟垚 SDK寮€鍙戣€呬娇鐢ㄥ悎瑙勮鑼?
娴佸紡璇煶璇嗗埆 SDK(鍚竴鍙ヨ瘽)
鍙戝竷淇℃伅
SDK姒傝
Android
闆嗘垚鎸囧崡
璋冪敤娴佺▼

iOS
闆嗘垚鎸囧崡
璋冪敤娴佺▼

澶фā鍨嬫祦寮忚瘑鍒玈DK
鍙屽悜娴佸紡TTS - iOS SDK 鎺ュ彛鏂囨。
鍙屽悜娴佸紡TTS - Android SDK 鎺ュ彛鏂囨。

绔埌绔疄鏃惰闊虫帴鍙?绔埌绔疄鏃惰闊冲ぇ妯″瀷API鎺ュ叆鏂囨。
绔埌绔痠OS SDK 鎺ュ彛鏂囨。
绔埌绔疉ndroid SDK 鎺ュ彛鏂囨。

璞嗗寘璇煶濡欒
璇煶濡欒

- 鏂囨。棣栭〉
璞嗗寘璇煶璇煶鎾澶фā鍨嬭闊虫挱瀹㈠鍒跺叏鏂?
涓嬭浇 pdf

鎴戠殑鏀惰棌

璇煶鎾澶фā鍨?璇煶鎾
澶嶅埗鍏ㄦ枃

涓嬭浇 pdf

鎴戠殑鏀惰棌

璇煶鎾

鏂囨。鍙嶉
闂棶鍔╂墜

1 鎺ュ彛鍔熻兘 #
鐏北鎺у埗鍙板紑鍚瘯鐢細寮€閫氱鐞?瀵规彁渚涚殑闀挎枃鏈垨缃戦〉閾炬帴杩涜鍒嗘瀽鎬荤粨锛屼篃鍙互瀵逛竴涓壒瀹氳瘽棰樺仛鑱旂綉鎬荤粨锛屾渶缁堟祦寮忕敓鎴愬弻浜烘挱瀹㈤煶棰戙€?
2 鎺ュ彛璇存槑 #

2.1 璇锋眰Request #

璇锋眰璺緞 #
wss://openspeech.bytedance.com/api/v3/sami/podcasttts

寤鸿繛&閴存潈 #

Request Headers

- | Key
| 璇存槑
| 鏄惁蹇呴』
| Value绀轰緥

- | X-Api-Key
| 浣跨敤鐏北寮曟搸鎺у埗鍙拌幏鍙栫殑API Key锛屽彲鍙傝€?鑾峰彇API Key
| 鏄?| your-api-key

- | X-Api-Resource-Id
| 琛ㄧず璋冪敤鏈嶅姟鐨勮祫婧愪俊鎭?ID

- 鎾璇煶鍚堟垚锛歷olc.service_type.10050
| 鏄?| volc.service_type.10050

- | X-Api-Request-Id
| 鏍囪瘑瀹㈡埛绔姹侷D锛寀uid闅忔満瀛楃涓?| 鍚?| 67ee89ba-7050-4c04-a3d7-ac61a63499b3

Response Headers

- | Key
| 璇存槑
| Value绀轰緥

- | X-Tt-Logid
| 鏈嶅姟绔繑鍥炵殑 logid锛屽缓璁敤鎴疯幏鍙栧拰鎵撳嵃鏂逛究瀹氫綅闂
| 2025041513355271DF5CF1A0AE0508E78C

WebSocket 浜岃繘鍒跺崗璁?#
WebSocket 浣跨敤浜岃繘鍒跺崗璁紶杈撴暟鎹€?
鍗忚鐨勭粍鎴愮敱鑷冲皯 4 涓瓧鑺傜殑鍙彉 header銆乸ayload size 鍜?payload 涓夐儴鍒嗙粍鎴愶紝鍏朵腑

- header 鎻忚堪娑堟伅绫诲瀷銆佸簭鍒楀寲鏂瑰紡浠ュ強鍘嬬缉鏍煎紡绛変俊鎭紱

- payload size 鏄?payload 鐨勯暱搴︼紱

- payload 鏄叿浣撹礋杞藉唴瀹癸紝渚濇嵁娑堟伅绫诲瀷涓嶅悓 payload 鍐呭涓嶅悓锛?闇€娉ㄦ剰锛氬崗璁腑鏁存暟绫诲瀷鐨勫瓧娈甸兘浣跨敤澶х琛ㄧず銆?
浜岃繘鍒跺抚

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0 - Left half
| Protocol version
| | 鐩墠鍙湁v1锛屽缁堝～0b0001

- | 0 - Right half
| | Header size (4x)
| 鐩墠鍙湁4瀛楄妭锛屽缁堝～0b0001

- | 1 - Left half
| Message type
| | 鍥哄畾涓?b001

- | 1 - Right half
| | Message type specific flags
| 鍦╯endText鏃讹紝涓?

鍦╢inishConnection鏃讹紝涓?b100

- | 2 - Left half
| Serialization method
| | 0b0000锛歊aw锛堟棤鐗规畩搴忓垪鍖栨柟寮忥紝涓昏閽堝浜岃繘鍒堕煶棰戞暟鎹級0b0001锛欽SON锛堜富瑕侀拡瀵规枃鏈被鍨嬫秷鎭級

- | 2 - Right half
| | Compression method
| 0b0000锛氭棤鍘嬬缉0b0001锛歡zip

- | 3
| Reserved
| 鐣欑┖锛?b0000 0000锛?
- | [4 ~ 7]
| [Optional field,like event number,...]
| 鍙栧喅浜嶮essage type specific flags锛屽彲鑳芥湁銆佷篃鍙兘娌℃湁

- | ...
| Payload
| 鍙兘鏄煶棰戞暟鎹€佹枃鏈暟鎹€侀煶棰戞枃鏈贩鍚堟暟鎹?
payload璇锋眰鍙傛暟

- | 瀛楁
| 鎻忚堪
| 鏄惁蹇呴』
| 绫诲瀷
| 榛樿鍊?
- | action
| 鐢熸垚绫诲瀷锛?
- 0锛氭牴鎹彁渚涚殑 input_text 鎴栬€?input_info.input_url 鎬荤粨鐢熸垚鎾

- 3锛氭牴鎹彁渚涚殑 nlp_texts 瀵硅瘽鏂囨湰鐩存帴鐢熸垚鎾

- 4锛氭牴鎹彁渚涚殑 prompt_text 鏂囨湰鑱旂綉鐢熸垚鎾
| 鏄?| number
| 0

- | input_text
| 寰呮挱瀹㈠悎鎴愯緭鍏ユ枃鏈紝涓婁笅鏂囨渶闀?32k锛岃秴杩囦細鎶ラ敊
action = 0 鏃跺€欏拰 input_info.input_url 浜岄€変竴锛岄兘涓嶄负绌轰紭鍏堢敓鏁?input_text
| 鍚?| string
| 鈥斺€?
- | prompt_text
| prompt鏂囨湰锛屼笉鍏峰鎸囦护鑳藉姏
action = 4 鏃跺繀濉?
涓€鑸瘮杈冪畝鍗曪紝姣斿 鈥滅伀灞卞紩鎿庘€?锛屸€滄€庝箞骞宠　宸ヤ綔鍜岀敓娲伙紵鈥?| 鍚?| string
| 鈥斺€?
- | nlp_texts
| 寰呭悎鎴愮殑鎾杞鏂囨湰鍒楄〃
action = 3 鏃跺繀濉?| 鍚?| []object
| 鈥斺€?
- | nlp_texts.text
| 姣忎釜杞鎾鏂囨湰
鍗曡疆涓嶈秴杩?300 瀛楃

鎬绘枃鏈暱搴︿笉瓒呰繃 10000 瀛楃
| 鍚?| string
| 鈥斺€?
- | nlp_texts.speaker
| 姣忎釜杞鎾鍙戦煶浜?璇︾粏鍙傝锛氬彲閫夊彂闊充汉鍒楄〃
| 鍚?| string
| 鈥斺€?
- | input_info
| 杈撳叆杈呭姪淇℃伅
| 鍚?| object
| 鈥斺€?
- | input_info.input_url
| 缃戦〉閾炬帴鎴栬€呭彲涓嬭浇鐨勬枃浠?pdf,doc,txt)閾炬帴,浼氳嚜鍔ㄨ浆鎹㈡垚闀挎枃鎾鏂囨湰
| 鍚?| string
| 鈥斺€?
- | input_info.only_nlp_text
| 鍙緭鍑烘挱瀹㈣疆娆℃枃鏈垪琛紝娌℃湁闊抽锛岄粯璁ゅ€间负false
| 鍚?| bool
| 鈥斺€?
- | input_info.return_audio_url
| 杩斿洖鍙笅杞界殑瀹屾暣鎾闊抽閾炬帴锛屾湁鏁堟湡 1h
鏂板涓€涓簨浠?363 锛圥odcastEnd锛夛紝閲岄潰浼氭湁 meta_info.audio_url 瀛楁
| 鍚?| bool
| 鈥斺€?
- | input_info.input_text_max_length
| 褰揳ction=0鏃讹紝鏀寔璁剧疆妯″瀷澶勭悊鐨勬渶澶у瓧绗︽暟锛岄粯璁や负 20000 瀛楃銆傜郴缁熶細鑷姩鎴柇瓒呰繃璁惧畾鍊肩殑鏂囨湰锛屼负淇濊瘉妯″瀷澶勭悊鐨勭ǔ瀹氭€э紝寤鸿鍙栧€尖墻12000瀛楃
浜嬩欢 363 锛圥odcastEnd锛夛紝閲岄潰浼氭湁input_metrics琛ㄧず鎴柇淇℃伅
| 鍚?| int
| 鈥斺€?
- | input_info.max_char_length_per_round
| 姣忚疆鏈€澶у悎鎴愬瓧绗︽暟锛岄粯璁や负 300 瀛楃銆傝揪鍒颁笂闄愭椂涓嶅仛纭埅鏂紝浼樺厛鍦ㄥ彞鍙凤紙銆傦級绛夊彞鏈爣鐐瑰鏂彞锛屼繚璇佽鍙ュ畬鏁村悗锛屽啀鍒ゆ柇鏄惁瓒呭嚭瀛楃涓婇檺
| 鍚?| int
| 鈥斺€?
- | input_info.strict_audit
| 鐢ㄤ簬澹版槑瀹夊叏瀹℃牳绛夌骇锛宼rue浠ｈ〃涓ユ牸瀹℃牳銆乫alse浠ｈ〃鏅€氬鏍革紝榛樿涓篺alse
| 鍚?| bool
| false

- | use_head_music
| 鏄惁浣跨敤寮€澶撮煶鏁?| 鍚?| bool
| true

- | use_tail_music
| 鏄惁浣跨敤缁撳熬闊虫晥
| 鍚?| bool
| false

- | aigc_watermark
| 鏄惁鍦ㄥ悎鎴愮粨灏惧鍔犻煶棰戣妭濂忔爣璇嗭紝浣滀负鏄剧ず姘村嵃
| 鍚?| bool
| false

- | aigc_metadata
| 鍦ㄥ悎鎴愰煶棰?header鍔犲叆鍏冩暟鎹殣寮忔按鍗帮紝鏀寔 mp3/wav/ogg_opus
| 鍚?| object
| 鈥斺€?
- | aigc_metadata.enable
| 鏄惁鍚敤闅愬紡姘村嵃
| 鍚?| bool
| false

- | aigc_metadata.content_producer
| 鍚堟垚鏈嶅姟鎻愪緵鑰呯殑鍚嶇О鎴栫紪鐮?| 鍚?| string
| ""

- | aigc_metadata.produce_id
| 鍐呭鍒朵綔缂栧彿
| 鍚?| string
| ""

- | aigc_metadata.content_propagator
| 鍐呭浼犳挱鏈嶅姟鎻愪緵鑰呯殑鍚嶇О鎴栫紪鐮?| 鍚?| string
| ""

- | aigc_metadata.propagate_id
| 鍐呭浼犳挱缂栧彿
| 鍚?| string
| ""

- | audio_config
| 闊抽鍙傛暟锛屼究浜庢湇鍔¤妭鐪侀煶棰戣В鐮佽€楁椂
| 鍚?| object
| 鈥斺€?
- | audio_config.format
| 闊抽缂栫爜鏍煎紡锛宮p3/ogg_opus/pcm/aac
| 鍚?| string
| pcm

- | audio_config.sample_rate
| 闊抽閲囨牱鐜囷紝鍙€夊€?[16000, 24000, 48000]
| 鍚?| number
| 24000

- | audio_config.speech_rate
| 璇€燂紝鍙栧€艰寖鍥碵-50,100]锛?00浠ｈ〃2.0鍊嶉€燂紝-50浠ｈ〃0.5鍊嶆暟
| 鍚?| number
| 0

- | speaker_info
| 鎸囧畾鍙戦煶浜轰俊鎭?| 鍚?| object
| 鈥斺€?
- | speaker_info.random_order
| 鍙戦煶浜烘槸鍚﹂殢鏈洪『搴忓紑濮嬶紝榛樿鏄?| 鍚?| bool
| true

- | speaker_info.speakers
| 鎾鍙戦煶浜? 鍙兘閫夋嫨 2 鍙戦煶浜?璇︾粏鍙傝锛氬彲閫夊彂闊充汉鍒楄〃
| 鍚?| []string
|

- | speaker_info.speaker_additions
| 鍙戦煶浜洪澶栦俊鎭紝浣跨敤 TTS 鍜?ICL 闊宠壊鐨勬椂鍊欏彲鐢熸晥锛?
key: speaker_id

value: 鍙傝€僼ts 鍚堟垚鏂囨。锛坔ttps://www.volcengine.com/docs/6561/1719100?lang=zh锛夐噷闈㈢殑 銆恟eq_params.additions銆?鍙傛暟锛屾槸涓猨sonstring
鍦ㄤ娇鐢ㄥ鍒?2.0 闊宠壊鐨勪娇鐢ㄥ鏋滆鍒囨崲妯″瀷涔熼渶瑕佽緭鍏ュ埌涓嬮潰鐨刟dditions鍙傛暟閲岄潰銆俶odel 鍙傛暟鐨勫彇鍊煎弬鑰冧笂杩版枃妗ｉ噷闈€恟eq_params.model銆戠殑浠嬬粛銆?鍙傝€冿細{"SPEAKERID1": additions, "SPEAKERID2": additions}

Golang:

additions = fmt.Sprintf("{"model": "seed-tts-2.0-standard"}")
Python:

additions = json.dumps({"model": "seed-tts-2.0-standard"})
| 鍚?| map[string][string]
| 鈥斺€?
- | retry_info
| 閲嶈瘯淇℃伅
| 鍚?| object
| 鈥斺€?
- | retry_info.retry_task_id
| 鍓嶄竴涓病鑾峰彇瀹屾暣鐨勬挱瀹㈣褰曠殑 task_id(绗竴娆tartSession浣跨敤鐨?session_id灏辨槸浠诲姟鐨?task_id)
| 鍚?| string
| 鈥斺€?
- | retry_info.last_finished_round_id
| 鍓嶄竴涓幏鍙栧畬鏁寸殑鎾璁板綍鐨勮疆娆?id
| 鍚?| number
| 鈥斺€?
鍙€夊彂闊充汉鍒楄〃
鍙戦煶浜虹殑閫夋嫨鏈€濂界敤鍚屼釜绯诲垪鐨勯厤瀵逛娇鐢ㄤ細鏈夋洿濂界殑鏁堟灉

榛樿锛歞ayi/mizai 绯诲垪

- | 绯诲垪
| 鍙戦煶浜哄悕绉?
- | 榛戠尗渚︽帰绀惧挭浠?| zh_female_mizaitongxue_v2_saturn_bigtts

- | zh_male_dayixiansheng_v2_saturn_bigtts

- | 鍒橀鍜屾絿纾?| zh_male_liufei_v2_saturn_bigtts

- | zh_male_xiaolei_v2_saturn_bigtts

- | TTS 闊宠壊鍒楄〃
| https://www.volcengine.com/docs/6561/1257544?lang=zh

鍙傛暟浣跨敤绀轰緥

action = 0 闀挎枃鏈€荤粨妯″紡绀轰緥
{
"input_text": "鍒嗘瀽涓嬪綋鍓嶇殑澶фā鍨嬪彂灞?,
"action": 0,
"use_head_music": false,
"audio_config": {
"format": "mp3",
"sample_rate": 24000,
"speech_rate": 0
},
"speaker_info": {
"random_order": true,
"speakers": [
"zh_male_dayixiansheng_v2_saturn_bigtts",
"zh_female_mizaitongxue_v2_saturn_bigtts"
]
},
"aigc_watermark": false,
"aigc_metadata": {
"enable": true,
"content_producer": "volcengine",
"produce_id": "12abc",
"content_propagator": "volcengine",
"propagate_id": "34def"
}
}
JSON

action = 0 url 瑙ｆ瀽妯″紡绀轰緥
{
"action": 0,
"use_head_music": false,
"audio_config": {
"format": "mp3",
"sample_rate": 24000,
"speech_rate": 0,
},
"input_info": {
"input_url": "https://mp.weixin.qq.com/s/CiN0XRWQc3hIV9lLLS0rGA"
}
}
JSON

action = 3 鏍规嵁鎻愪緵鐨勫璇濇枃鏈皟鐢ㄧず渚?{
"action": 3,
"use_head_music": false,
"audio_config": {
"format": "mp3",
"sample_rate": 24000,
"speech_rate": 0,
},
"nlp_texts": [
{
"speaker": "zh_male_dayixiansheng_v2_saturn_bigtts",
"text": "浠婂ぉ鍛㈡垜浠鑱婄殑鍛㈡槸鐏北寮曟搸鍦ㄨ繖涓?FORCE 鍘熷姩鍔涘ぇ浼氫笂闈㈢殑涓€浜涙瘮杈冮噸纾呯殑鍙戝竷銆?
},
{
"speaker": "zh_female_mizaitongxue_v2_saturn_bigtts",
"text": "鏉ョ湅鐪嬮兘鏈夊摢浜涗寒鐐瑰搱銆?
}
]
}
JSON

action = 4 鏍规嵁鎻愪緵prompt鏂囨湰鑱旂綉鎬荤粨璋冪敤绀轰緥
{
"action": 4,
"prompt_text": "鐏北寮曟搸",
"use_head_music": false,
"audio_config": {
"format": "mp3",
"sample_rate": 24000,
"speech_rate": 0,
}
}
JSON

2.2 鍝嶅簲Response #

寤鸿繛鍝嶅簲 #
涓昏鍏虫敞寤鸿繛闃舵 HTTP Response 鐨勭姸鎬佺爜鍜?Body

- 寤鸿繛鎴愬姛锛氱姸鎬佺爜涓?200

- 寤鸿繛澶辫触锛氱姸鎬佺爜涓嶄负 200锛孊ody 涓彁渚涢敊璇師鍥犺鏄?
WebSocket 浼犺緭鍝嶅簲 #

浜岃繘鍒跺抚 - 姝ｅ父鍝嶅簲甯?
- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0 - Left half
| Protocol version
| | 鐩墠鍙湁v1锛屽缁堝～0b0001

- | 0 - Right half
| | Header size (4x)
| 鐩墠鍙湁4瀛楄妭锛屽缁堝～0b0001

- | 1 - Left half
| Message type
| | 闊抽甯ц繑鍥烇細0b1011

鍏朵粬甯ц繑鍥烇細0b1001

- | 1 - Right half
| | Message type specific flags
| 鍥哄畾涓?b0100

- | 2 - Left half
| Serialization method
| | 0b0000锛歊aw锛堟棤鐗规畩搴忓垪鍖栨柟寮忥紝涓昏閽堝浜岃繘鍒堕煶棰戞暟鎹級0b0001锛欽SON锛堜富瑕侀拡瀵规枃鏈被鍨嬫秷鎭級

- | 2 - Right half
| | Compression method
| 0b0000锛氭棤鍘嬬缉0b0001锛歡zip

- | 3
| Reserved
| 鐣欑┖锛?b0000 0000锛?
- | [4 ~ 7]
| [Optional field,like event number,...]
| 鍙栧喅浜嶮essage type specific flags锛屽彲鑳芥湁銆佷篃鍙兘娌℃湁

- | ...
| Payload
| 鍙兘鏄煶棰戞暟鎹€佹枃鏈暟鎹€侀煶棰戞枃鏈贩鍚堟暟鎹?
payload鍝嶅簲鍙傛暟

- | 瀛楁
| 鎻忚堪
| 绫诲瀷

- | data
| 杩斿洖鐨勪簩杩涘埗鏁版嵁鍖?| byte

- | event
| 杩斿洖鐨勪簨浠剁被鍨?| number

浜岃繘鍒跺抚 - 閿欒鍝嶅簲甯?
- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0 - Left half
| Protocol version
| | 鐩墠鍙湁v1锛屽缁堝～0b0001

- | 0 - Right half
| | Header size (4x)
| 鐩墠鍙湁4瀛楄妭锛屽缁堝～0b0001

- | 1
| Message type
| Message type specific flags
| 0b11110000

- | 2 - Left half
| Serialization method
| | 0b0000锛歊aw锛堟棤鐗规畩搴忓垪鍖栨柟寮忥紝涓昏閽堝浜岃繘鍒堕煶棰戞暟鎹級0b0001锛欽SON锛堜富瑕侀拡瀵规枃鏈被鍨嬫秷鎭級

- | 2 - Right half
| | Compression method
| 0b0000锛氭棤鍘嬬缉0b0001锛歡zip

- | 3
| Reserved
| 鐣欑┖锛?b0000 0000锛?
- | [4 ~ 7]
| Error code
| 閿欒鐮?
- | ...
| Payload
| 閿欒娑堟伅瀵硅薄

2.3 event瀹氫箟 #
鍦ㄧ敓鎴?podcast 闃舵锛屼笉闇€瑕佸鎴风鍙戦€佷笂琛岀殑event甯с€俥vent绫诲瀷濡備笅锛?
- | Event code
| 鍚箟
| 浜嬩欢绫诲瀷
| 搴旂敤闃舵锛氫笂琛?涓嬭

- | 150
| SessionStarted锛屼細璇濅换鍔″紑濮?| Session 绫?| 涓嬭

- | 360
| PodcastRoundStart锛屾挱瀹㈣繑鍥炴柊杞鍐呭寮€濮嬶紝甯︾潃杞 idx 鍜?speaker
| 鏁版嵁绫?| 涓嬭

- | 361
| PodcastRoundResponse锛屾挱瀹㈣繑鍥炶疆娆＄殑闊抽鍐呭
| 鏁版嵁绫?| 涓嬭

- | 362
| PodcastRoundEnd锛屾挱瀹㈣繑鍥炲唴瀹瑰綋鍓嶈疆娆＄粨鏉?
绀轰緥锛?
{

"audio_duration":8.419333, // 鍗曚綅绉掞紝鏃堕暱

"end_time":38.216, // 鍗曚綅绉掞紝寮€濮嬫椂闂?
"start_time":25.25 // 鍗曚綅绉掞紝缁撴潫鏃堕棿

}
| 鏁版嵁绫?| 涓嬭

- | 363
| PodcastEnd锛岃繑鍥炰竴浜涙挱瀹㈡€荤粨鎬х殑淇℃伅锛岃〃绀烘挱瀹㈢粨鏉燂紙涓轰簡鍏煎涔嬪墠鐨勪娇鐢紝杩欎釜浜嬩欢涓嶄竴瀹氫細杩斿洖锛?
绀轰緥锛歿'meta_info': {'audio_url': 'https://speech-tts-podcast.tos-cn-beijing.volces.com/speech-tts-podcast/tts_audio/aGjiRDfUWi/b598a76a-ebb2-4117-9270-9b3b740e1adb/podcast_demo.mp3?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=<REDACTED_AK>%2F20250825%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Date=20250825T070712Z&X-Tos-Expires=3600&X-Tos-Signature=55a5e2d0bd40f91fc846068f9d35737b96e9891134aabb783b973f91b5f993c9&X-Tos-SignedHeaders=host', 'topics': null, 'input_metrics': {'origin_input_text_length': 14, 'input_text_length': 10, 'input_text_truncated': true}}}
| 鏁版嵁绫?| 涓嬭

- | 152
| SessionFinished锛屼細璇濆凡缁撴潫锛堜笂琛?涓嬭锛?
鏍囪瘑璇煶涓€涓畬鏁寸殑璇煶鍚堟垚瀹屾垚
| Session 绫?| 涓嬭

- | 154
| UsageResponse, 鎾杩斿洖鐨勭敤閲忎簨浠躲€?
绀轰緥:{"usage":{"input_text_tokens":980,"output_audio_tokens":0}} 鍏朵腑input_text_tokens琛ㄧず"API璋冪敤token-杈撳叆-鏂囨湰", output_audio_tokens琛ㄧず"API璋冪敤token-杈撳嚭-闊抽" 銆?| 鏁版嵁绫?| 涓嬭

鍦ㄥ叧闂繛鎺ラ樁娈碉紝闇€瑕佸鎴风浼犻€掍笂琛宔vent甯у幓鍏抽棴杩炴帴銆俥vent绫诲瀷濡備笅锛?
- | Event code
| 鍚箟
| 浜嬩欢绫诲瀷
| 搴旂敤闃舵锛氫笂琛?涓嬭

- | 2
| FinishConnection锛岀粨鏉熻繛鎺?| Connect 绫?| 涓婅

- | 52
| ConnectionFinished 缁撴潫杩炴帴鎴愬姛
| Connect 绫?| 涓嬭

绀烘剰鍥撅紙閲嶈锛侊紒锛侊紒锛夛細

2.4 涓嶅悓绫诲瀷甯т妇渚嬭鏄?#

StartSession #

璇锋眰 request

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| StartSession
| event type

- | 8 ~ 11
| uint32(12)
| | len(<session_id>)

- | 12 ~ 23
| nxckjoejnkegf
| | session_id

- | 24 ~ 27
| uint32( ...)
| | len(payload)

- | 28 ~ ...
| {}
| payload 瑙佷笅闈㈢殑渚嬪瓙

payload
{
"input_text": "鍒嗘瀽涓嬪綋鍓嶇殑澶фā鍨嬪彂灞?,
"action": 0,
"use_head_music": false,
"audio_config": {
"format": "pcm",
"sample_rate": 24000,
"speech_rate": 0,
}
}
JSON

鏂偣缁紶鐨勬椂鍊欓渶瑕佸姞涓?retry 淇℃伅
payload
{
"input_text": "鍒嗘瀽涓嬪綋鍓嶇殑澶фā鍨嬪彂灞?,
"action": 0,
"use_head_music": false,
"audio_config": {
"format": "pcm",
"sample_rate": 24000,
"speech_rate": 0,
},
"retry_info": {
"retry_task_id": "xxxxxxxxx",
"last_finished_round_id": 5
}
}
JSON

鍝嶅簲Response

SessionStarted

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1011
| 0100
| Audio-only response
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| SessionStarted
| event type
|

- | 8 ~ 11
| uint32(12)
| len(<session_id>)
|

- | 12 ~ 23
| nxckjoejnkegf
| session_id
|

- | 24 ~ 27
| uint32( ...)
| len(audio_binary)
|

- | 28 ~ ...
| {

}
| payload_json

鎵╁睍淇濈暀锛屾殏鐣欑┖JSON
|

UsageResponse

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1011
| 0100
| Audio-only response
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| UsageResponse
| event type
|

- | 8 ~ 11
| uint32(12)
| len(<session_id>)
|

- | 12 ~ 23
| nxckjoejnkegf
| session_id
|

- | 24 ~ 27
| uint32( ...)
| len(audio_binary)
|

- | 28 ~ ...
| 鏂囨湰 token 娑堣€楁帹閫侊細

{"usage":{"input_text_tokens":980,"output_audio_tokens":0}}

闊抽 token 娑堣€楁帹閫侊細

{"usage":{"input_text_tokens": 0,"output_audio_tokens":501}}
| payload_json

鐢ㄩ噺淇℃伅
|

涓嬮潰涓変釜浜嬩欢寰幆 鈾伙笍,濡傛灉娌℃湁鏀跺埌PodcastTTSRoundEnd锛堥渶瑕佸拰PodcastSpeaker鎴愬鍑虹幇锛夊氨鏂帀浜嗛摼鎺ヨ鏄庨渶瑕佹柇鐐圭画浼犻噸鏂板彂璧疯姹?
PodcastRoundStart

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1011
| 0100
| Audio-only response
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| PodcastRoundStart
| event type
|

- | 8 ~ 11
| uint32(12)
| len(<session_id>)
|

- | 12 ~ 23
| nxckjoejnkegf
| session_id
|

- | 24 ~ 27
| uint32( ...)
| len(audio_binary)
|

- | 28 ~ ...
| {

"text_type": "", // 鏂囨湰绫诲瀷

"speaker": "", // 鏈璇磋瘽speaker

"round_id": -1, // 瀵硅瘽杞锛?1 鏄紑澶撮煶涔?
"text": "" // 瀵硅瘽鏂囨湰

}
| response_meta_json
round_id == -1锛屼唬琛ㄥ紑澶撮煶棰?
round_id ==9999锛屼唬琛ㄧ粨灏鹃煶棰?|

PodcastRoundResponse

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| PodcastTTSResponse
| event type

- | 8 ~ 11
| uint32(12)
| | len(<session_id>)

- | 12 ~ 23
| nxckjoejnkegf
| | session_id

- | 24 ~ 27
| uint32( ...)
| | len(payload)

- | 28 ~ ...
| ... 闊抽鍐呭
| payload

PodcastRoundEnd

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| PodcastRoundEnd
| event type
|

- | 8 ~ 11
| uint32(12)
| len(<session_id>)

- | 12 ~ 23
| nxckjoejnkegf
| session_id

- | 24 ~ 27
| uint32( ...)
| len(response_meta_json)

- | 28 ~ ...
| {

"is_error": true,

"error_msg": "something error"

}

or

{

"audio_duration":8.419333, // 鍗曚綅绉?
"end_time":38.216, // 鍗曚綅绉?
"start_time":25.25 // 鍗曚綅绉?
}
姣忓彞鎾杩斿洖甯︾潃鏃堕暱浠ュ強鍦ㄥ畬鏁存挱瀹㈤煶棰戠殑寮€濮嬪拰缁撴潫鏃堕棿浣嶇疆銆?| response_meta_json

PodcastEnd

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| PodcastEnd
| event type
|

- | 8 ~ 11
| uint32(12)
| len(<session_id>)

- | 12 ~ 23
| nxckjoejnkegf
| session_id

- | 24 ~ 27
| uint32( ...)
| len(response_meta_json)

- | 28 ~ ...
| {'meta_info': {'audio_url': 'https://speech-tts-podcast.tos-cn-beijing.volces.com/speech-tts-podcast/tts_audio/aGjiRDfUWi/a0979493-196a-42ad-aff1-1dfe63c7e219/podcast_demo.mp3?X-Tos-Algorithm=TOS4-HMAC-SHA256&X-Tos-Credential=<REDACTED_AK>%2F20250825%2Fcn-beijing%2Ftos%2Frequest&X-Tos-Date=20250825T084035Z&X-Tos-Expires=3600&X-Tos-Signature=2a549ee5f5ed8a32ce34d475ccf56f50a02e78b3431eb760fb9edc3d0d15296b&X-Tos-SignedHeaders=host', 'topics': None}}
| response_meta_json

娌℃湁闇€瑕佽繑鍥炵殑 meta 淇℃伅杩欎釜浜嬩欢涓嶄細鎺ㄩ€?
FinishSession #

璇锋眰request

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| FinishSession
| event type

- | 8 ~ 11
| uint32(12)
| | len(<session_id>)

- | 12 ~ 23
| nxckjoejnkegf
| | session_id

- | 24 ~ 27
| uint32( ...)
| | len(payload)

- | 28 ~ ...
| {}
| tts_session_meta

鍝嶅簲response

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| SessionFinished
| event type

- | 8 ~ 11
| uint32(7)
| len(<connection_id>)

- | 12 ~ 15
| uint32(58)
| len(<response_meta_json>)

- | 28 ~ ...
| {

"status_code": 20000000,

"message": "ok"

}
| response_meta_json

- 浠呭惈status_code鍜宮essage瀛楁

FinishConnection #

璇锋眰request

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| FinishConnection
| event type

- | 8 ~ 11
| uint32(2)
| len(<response_meta_json>)

- | 12 ~ 13
| {}
| tts_session_meta

鍝嶅簲response

- | Byte
| Left 4-bit
| Right 4-bit
| 璇存槑

- | 0
| 0001
| 0001
| v1
| 4-byte header

- | 1
| 1001
| 0100
| Full-client request
| with event number

- | 2
| 0001
| 0000
| JSON
| no compression

- | 3
| 0000
| 0000
| |

- | 4 ~ 7
| ConnectionFinished
| event type

- | 8 ~ 11
| uint32(7)
| len(<connection_id>)

- | 12 ~ 15
| uint32(58)
| len(<response_meta_json>)

- | 28 ~ ...
| {

"status_code": 20000000,

"message": "ok"

}
| response_meta_json

- 浠呭惈status_code鍜宮essage瀛楁

3 閿欒鐮?#

- | Code
| Message
| 璇存槑

- | 20000000
| ok
| 闊抽鍚堟垚缁撴潫鐨勬垚鍔熺姸鎬佺爜

- | 45000000
| quota exceeded for types: concurrency
| 骞跺彂闄愭祦锛屼竴鑸槸璇锋眰骞跺彂鏁拌秴杩囬檺鍒?
- | 40000010
| PodcastTTS invalid param
| 鍙傛暟閿欒锛屾牴鎹?msg 淇℃伅妫€娴嬪叆鍙傛槸鍚︽纭?
- | 40000022
| IllegalPayload:TextRiskAuditFailed
| 寮€鍚弗鏍奸鎺т箣鍚庡懡涓鎺у悎鎴愬け璐ワ紝寤鸿妫€鏌ヨ緭鍏ユ枃鏈?
- | 55000000
| 鏈嶅姟绔竴浜沞rror
| 鏈嶅姟绔€氱敤閿欒

- | 50302102
| action = 0 鐨勬姤閿欙細

NLP RespError(50000001/FangzhouPodcastNLPFailed:content filter)
action = 4 鐨勬姤閿欙細

NLP RespError(50000001/server error: GetOutlineFailed:Failed to generate the podcast. The cause of the error is: content filter)

鎴栬€?
NLP RespError(50000001/server error: GetOutlineFailed:Failed to generate the podcast. The cause of the error is: get outline base model return empty)
| 瑙﹀彂瀹夊叏瀹℃牳杩囨护

- | 50302102
| NLP RespError(50000001/FangzhouPodcastNLPFailed:content length)
| 鏂囨湰涓婁笅鏂囪秴杩囬檺鍒?
4 璋冪敤绀轰緥 #
Python璋冪敤绀轰緥
Java璋冪敤绀轰緥
Go璋冪敤绀轰緥
C#璋冪敤绀轰緥
TypeScript璋冪敤绀轰緥

鍓嶆彁鏉′欢 #

- 璋冪敤涔嬪墠锛屾偍闇€瑕佽幏鍙栦互涓嬩俊鎭細

- <appid>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙PP ID锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
- <access_token>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙ccess Token锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
Python鐜 #

- Python锛?.9鐗堟湰鍙婁互涓娿€?
- Pip锛?5.1.1鐗堟湰鍙婁互涓娿€傛偍鍙互浣跨敤涓嬮潰鍛戒护瀹夎銆?python3 -m pip install --upgrade pip
Bash

涓嬭浇浠ｇ爜绀轰緥 #
volcengine.speech.volc_speech_python_sdk_1.0.0.25.tar.gz
鏈煡澶у皬

瑙ｅ帇缂╀唬鐮佸寘锛屽畨瑁呬緷璧?mkdir -p volcengine_podcasts_demo
tar xvzf volcengine_podcasts_demo.tar.gz -C ./volcengine_podcasts_demo
cd volcengine_podcasts_demo
python3 -m venv .venv
source .venv/bin/activate
python3 -m pip install --upgrade pip
pip3 install -e .
Bash

鍙戣捣璋冪敤 #
<appid>鏇挎崲涓烘偍鐨凙PP ID銆?<access_token>鏇挎崲涓烘偍鐨凙ccess Token銆?<text> 涓烘挱瀹㈡枃鏈€?python3 examples/volcengine/podcasts.py --appid <appid> --access_token <access_token> --text "浠嬬粛涓嬬伀灞卞紩鎿?
Bash

鍓嶆彁鏉′欢 #

- 璋冪敤涔嬪墠锛屾偍闇€瑕佽幏鍙栦互涓嬩俊鎭細

- <appid>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙PP ID锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
- <access_token>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙ccess Token锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
Java鐜 #

- Java锛?1鐗堟湰鍙婁互涓娿€?
- Maven锛?.9.10鐗堟湰鍙婁互涓娿€?
涓嬭浇浠ｇ爜绀轰緥 #
volcengine.speech.volc_speech_java_sdk_1.0.0.19.tar.gz
鏈煡澶у皬

瑙ｅ帇缂╀唬鐮佸寘锛屽畨瑁呬緷璧?mkdir -p volcengine_podcasts_demo
tar xvzf volcengine_podcasts_demo.tar.gz -C ./volcengine_podcasts_demo
cd volcengine_podcasts_demo
Bash

鍙戣捣璋冪敤 #
<appid>鏇挎崲涓烘偍鐨凙PP ID銆?<access_token>鏇挎崲涓烘偍鐨凙ccess Token銆?<text> 涓烘挱瀹㈡枃鏈€?mvn compile exec:java -Dexec.mainClass=com.speech.volcengine.Podcasts -DappId=<appid> -DaccessToken=<access_token> -Dtext="浠嬬粛涓嬬伀灞卞紩鎿?
Bash

鍓嶆彁鏉′欢 #

- 璋冪敤涔嬪墠锛屾偍闇€瑕佽幏鍙栦互涓嬩俊鎭細

- <appid>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙PP ID锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
- <access_token>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙ccess Token锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
Go鐜 #

- Go锛?.21.0鐗堟湰鍙婁互涓娿€?
涓嬭浇浠ｇ爜绀轰緥 #
volcengine.speech.volc_speech_go_sdk_1.0.0.23.tar.gz
鏈煡澶у皬

瑙ｅ帇缂╀唬鐮佸寘锛屽畨瑁呬緷璧?mkdir -p volcengine_podcasts_demo
tar xvzf volcengine_podcasts_demo.tar.gz -C ./volcengine_podcasts_demo
cd volcengine_podcasts_demo
Bash

鍙戣捣璋冪敤 #
<appid>鏇挎崲涓烘偍鐨凙PP ID銆?<access_token>鏇挎崲涓烘偍鐨凙ccess Token銆?<text> 涓烘挱瀹㈡枃鏈€?go run volcengine/podcasts/main.go --appid <appid> --access_token <access_token> --text "浠嬬粛涓嬬伀灞卞紩鎿?
Bash

鍓嶆彁鏉′欢 #

- 璋冪敤涔嬪墠锛屾偍闇€瑕佽幏鍙栦互涓嬩俊鎭細

- <appid>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙PP ID锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
- <access_token>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙ccess Token锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
C#鐜 #

- .Net 9.0鐗堟湰銆?
涓嬭浇浠ｇ爜绀轰緥 #
volcengine.speech.volc_speech_dotnet_sdk_1.0.0.13.tar.gz
鏈煡澶у皬

瑙ｅ帇缂╀唬鐮佸寘锛屽畨瑁呬緷璧?mkdir -p volcengine_podcasts_demo
tar xvzf volcengine_podcasts_demo.tar.gz -C ./volcengine_podcasts_demo
cd volcengine_podcasts_demo
Bash

鍙戣捣璋冪敤 #
<appid>鏇挎崲涓烘偍鐨凙PP ID銆?<access_token>鏇挎崲涓烘偍鐨凙ccess Token銆?<text> 涓烘挱瀹㈡枃鏈€?dotnet run --project Volcengine/Podcasts/Volcengine.Speech.Podcasts.csproj -- --appid <appid> --access_token <access_token> --text "浠嬬粛涓嬬伀灞卞紩鎿?
Bash

鍓嶆彁鏉′欢 #

- 璋冪敤涔嬪墠锛屾偍闇€瑕佽幏鍙栦互涓嬩俊鎭細

- <appid>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙PP ID锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
- <access_token>锛氫娇鐢ㄦ帶鍒跺彴鑾峰彇鐨凙ccess Token锛屽彲鍙傝€?鎺у埗鍙颁娇鐢‵AQ-Q1銆?
node鐜 #

- node锛歷24.0鐗堟湰鍙婁互涓娿€?
涓嬭浇浠ｇ爜绀轰緥 #
volcengine.speech.volc_speech_js_sdk_1.0.0.19.tar.gz
鏈煡澶у皬

瑙ｅ帇缂╀唬鐮佸寘锛屽畨瑁呬緷璧?#
mkdir -p volcengine_podcasts_demo
tar xvzf volcengine_podcasts_demo.tar.gz -C ./volcengine_podcasts_demo
cd volcengine_podcasts_demo
npm install
npm install -g typescript
npm install -g ts-node
Bash

鍙戣捣璋冪敤 #
<appid>鏇挎崲涓烘偍鐨凙PP ID銆?<access_token>鏇挎崲涓烘偍鐨凙ccess Token銆?<text> 涓烘挱瀹㈡枃鏈€?npx ts-node src/volcengine/podcasts.ts --appid <appid> --access_token <access_token> --text "浠嬬粛涓嬬伀灞卞紩鎿?
Bash

杈撳嚭闊抽 demo锛?
podcast_final.mp3
鏈煡澶у皬

鏈€杩戞洿鏂版椂闂达細2026.09.29 16:52:01
杩欎釜椤甸潰瀵规偍鏈夊府鍔╁悧锛熸湁鐢?
鏈夌敤

鏃犵敤

鏃犵敤

涓婁竴绡?绔埌绔疄鏃惰闊?
鍚屽０浼犺瘧

涓嬩竴绡?
鍦ㄧ嚎鍜ㄨ

榧犳爣閫変腑鍐呭锛屽揩閫熷弽棣堥棶棰?閫変腑瀛樺湪鐤戞儜鐨勫唴瀹癸紝鍗冲彲蹇€熷弽棣堥棶棰橈紝鎴戜滑灏嗕細璺熻繘澶勭悊
涓嶅啀鎻愮ず
濂界殑锛岀煡閬撲簡

鏂囨。鍙嶉

鐏北鍔╂墜

璐拱鍜ㄨ

鍏ㄥぉ鍊欏敭鍚庢湇鍔?7x24灏忔椂涓撲笟宸ョ▼甯堝搧璐ㄦ湇鍔?
鏋侀€熸湇鍔″簲绛?绉掔骇搴旂瓟涓轰笟鍔′繚椹炬姢鑸?
瀹㈡埛浠峰€间负鍏?浠庢湇鍔′环鍊煎埌鍒涢€犲鎴蜂环鍊?
鍏ㄦ柟浣嶅畨鍏ㄤ繚闅?鎵撻€犱竴鏈碘€滈€忔槑鍙俊鈥濈殑浜?
鍏ㄥぉ鍊欏敭鍚庢湇鍔?
鏋侀€熸湇鍔″簲绛?
瀹㈡埛浠峰€间负鍏?
鍏ㄦ柟浣嶅畨鍏ㄤ繚闅?
鍏充簬鎴戜滑
涓轰粈涔堥€夌伀灞?鏂囨。涓績
鑱旂郴鎴戜滑
浜烘墠鎷涜仒
浜戜俊浠讳腑蹇?鍙嬫儏閾炬帴

浜у搧
浜戞湇鍔″櫒
GPU浜戞湇鍔″櫒
鏈哄櫒瀛︿範骞冲彴
瀹㈡埛鏁版嵁骞冲彴 VeCDP
椋炶繛
瑙嗛鐩存挱
鍏ㄩ儴浜у搧

瑙ｅ喅鏂规
姹借溅琛屼笟
閲戣瀺琛屼笟
鏂囧ū琛屼笟
鍖荤枟鍋ュ悍琛屼笟
浼犲獟琛屼笟
鏅烘収鏂囨梾
澶ф秷璐?
鏈嶅姟涓庢敮鎸?澶囨鏈嶅姟
鏈嶅姟鍜ㄨ
寤鸿涓庡弽棣?寤夋磥鑸炲紛涓炬姤
涓炬姤骞冲彴

鑱旂郴鎴戜滑
涓氬姟鍜ㄨ锛歴ervice@volcengine.com
甯傚満鍚堜綔锛歮arketing@volcengine.com
鐢佃瘽锛?00-034-7888
鍦板潃锛氬寳浜競娴锋穩鍖哄寳涓夌幆瑗胯矾鐢?8鍙烽櫌澶ч挓瀵哄箍鍦?鍙锋ゼ

寰俊鍏紬鍙?
鎶栭煶鍙?
瑙嗛鍙?
鍏充簬鎴戜滑

涓轰粈涔堥€夌伀灞辨枃妗ｄ腑蹇冭仈绯绘垜浠汉鎵嶆嫑鑱樹簯淇′换涓績鍙嬫儏閾炬帴
浜у搧

浜戞湇鍔″櫒GPU浜戞湇鍔″櫒鏈哄櫒瀛︿範骞冲彴瀹㈡埛鏁版嵁骞冲彴 VeCDP椋炶繛瑙嗛鐩存挱鍏ㄩ儴浜у搧
瑙ｅ喅鏂规

姹借溅琛屼笟閲戣瀺琛屼笟鏂囧ū琛屼笟鍖荤枟鍋ュ悍琛屼笟浼犲獟琛屼笟鏅烘収鏂囨梾澶ф秷璐?鏈嶅姟涓庢敮鎸?
澶囨鏈嶅姟鏈嶅姟鍜ㄨ寤鸿涓庡弽棣堝粔娲佽垶寮婁妇鎶ヤ妇鎶ュ钩鍙?鑱旂郴鎴戜滑
涓氬姟鍜ㄨ锛歴ervice@volcengine.com
甯傚満鍚堜綔锛歮arketing@volcengine.com
鐢佃瘽锛?00-034-7888
鍦板潃锛氬寳浜競娴锋穩鍖哄寳涓夌幆瑗胯矾鐢?8鍙烽櫌澶ч挓瀵哄箍鍦?鍙锋ゼ

寰俊鍏紬鍙?
鎶栭煶鍙?
瑙嗛鍙?
鏈嶅姟鏉℃闅愮鏀跨瓥鏇村鍗忚
漏 鍖椾含鐏北寮曟搸绉戞妧鏈夐檺鍏徃 2026 鐗堟潈鎵€鏈変唬鐞嗗煙鍚嶆敞鍐屾湇鍔℃満鏋勶細鏂扮綉鏁扮爜 鍟嗕腑鍦ㄧ嚎浜叕缃戝畨澶?1010802032137鍙蜂含ICP澶?0018813鍙?3钀ヤ笟鎵х収澧炲€肩數淇′笟鍔＄粡钀ヨ鍙瘉浜珺2-20202418锛孉2.B1.B2-20202637缃戠粶鏂囧寲缁忚惀璁稿彲璇侊細浜綉鏂囷紙2023锛?872-140鍙峰煙鍚嶆敞鍐屾湇鍔℃満鏋勮鍙細浜珼3-20250002

漏 鍖椾含鐏北寮曟搸绉戞妧鏈夐檺鍏徃 2026 鐗堟潈鎵€鏈変唬鐞嗗煙鍚嶆敞鍐屾湇鍔℃満鏋勶細鏂扮綉鏁扮爜 鍟嗕腑鍦ㄧ嚎鏈嶅姟鏉℃闅愮鏀跨瓥鏇村鍗忚
浜叕缃戝畨澶?1010802032137鍙蜂含ICP澶?0018813鍙?3钀ヤ笟鎵х収澧炲€肩數淇′笟鍔＄粡钀ヨ鍙瘉浜珺2-20202418锛孉2.B1.B2-20202637缃戠粶鏂囧寲缁忚惀璁稿彲璇侊細浜綉鏂囷紙2023锛?872-140鍙峰煙鍚嶆敞鍐屾湇鍔℃満鏋勮鍙細浜珼3-20250002

涓氬姟鍜ㄨ

