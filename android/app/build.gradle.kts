plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// 打包时把用户在电脑端设置的贴图同步进 APK（不进源码仓库）
// 默认读 <项目>/GalleryMirrorData/stickers（跟着项目走，不再写死 D 盘绝对路径），可用环境变量 GM_STICKERS_DIR 覆盖
// 用 Sync 而不是 Copy：源目录里删掉的图也会从 APK 里移除
val userStickersSource = providers.environmentVariable("GM_STICKERS_DIR").orElse(rootProject.projectDir.parentFile.resolve("GalleryMirrorData/stickers").absolutePath)

val copyUserStickers = tasks.register<Sync>("copyUserStickers") {
    val source = file(userStickersSource.get())
    if (source.exists()) {
        from(source) {
            include("*.png", "*.jpg", "*.jpeg", "*.webp", "*.gif", "*.avif")
        }
    }
    into(layout.buildDirectory.dir("generated/userStickers/stickers"))
}

tasks.named("preBuild") {
    dependsOn(copyUserStickers)
}

android {
    namespace = "com.gallerymirror.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gallerymirror.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/userStickers"))
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = "17"
    }
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.activity:activity-ktx:1.9.2")
    implementation("androidx.lifecycle:lifecycle-runtime-ktx:2.8.5")
}
