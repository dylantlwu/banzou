plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}
android {
    namespace = "com.banzou.ktv"
    compileSdk = 34
    defaultConfig {
        applicationId = "com.banzou.ktv"
        minSdk = 21
        targetSdk = 22 // 安卓 5 电视：存储权限安装时就给，不用弹窗
        versionCode = 6
        versionName = "0.6.0"
    }
    buildTypes { release { isMinifyEnabled = false; signingConfig = signingConfigs.getByName("debug") } }
    compileOptions { sourceCompatibility = JavaVersion.VERSION_1_8; targetCompatibility = JavaVersion.VERSION_1_8 }
    kotlinOptions { jvmTarget = "1.8" }
    lint { abortOnError = false; checkReleaseBuilds = false }
}
dependencies {
    implementation("androidx.media3:media3-exoplayer:1.4.1")
    // 手机扫码点歌：电视上画二维码（3.3.x 只用 Java 7，Android 5 没问题）
    implementation("com.google.zxing:core:3.3.3")
    // 只给 Filters.kt 的纯函数做单元测试（./gradlew testDebugUnitTest），不进 APK
    testImplementation("junit:junit:4.13.2")
}
