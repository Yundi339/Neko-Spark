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

// release 签名只能从本机环境或 CI Secrets 注入，避免把私钥和密码写进仓库。
// 未提供正式签名时仍允许 assembleFormalRelease 生成未签名校验包，但发布脚本不会把它当成正式 APK。
fun signingInput(name: String): String =
    providers.environmentVariable(name)
        .orElse(providers.gradleProperty(name))
        .orNull
        .orEmpty()

val releaseKeystorePath = signingInput("ANDROID_KEYSTORE_PATH")
val releaseKeystorePassword = signingInput("ANDROID_KEYSTORE_PASSWORD")
val releaseKeyAlias = signingInput("ANDROID_KEY_ALIAS")
val releaseKeyPassword = signingInput("ANDROID_KEY_PASSWORD")
val hasReleaseSigning = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all(String::isNotBlank)

val buildVersionName = providers.gradleProperty("versionName")
    .orElse(providers.environmentVariable("VERSION_NAME"))
    .orNull
    .orEmpty()
    .ifBlank { "0.1.0" }
val buildVersionCode = providers.gradleProperty("versionCode")
    .orElse(providers.environmentVariable("VERSION_CODE"))
    .orNull
    ?.toIntOrNull()
    ?: 1

tasks.named("preBuild") {
    dependsOn(copyUserStickers)
}

android {
    namespace = "com.gallerymirror.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.gallerymirror.jiuerya"
        minSdk = 26
        targetSdk = 34
        versionCode = buildVersionCode
        versionName = buildVersionName
    }

    flavorDimensions += "package"
    productFlavors {
        create("formalApp") {
            dimension = "package"
            applicationId = "com.gallerymirror.jiuerya"
        }
        create("debugApp") {
            dimension = "package"
            applicationId = "com.gallerymirror.jiuerya_debug"
        }
    }

    sourceSets {
        getByName("main") {
            assets.srcDir(layout.buildDirectory.dir("generated/userStickers"))
        }
    }

    buildTypes {
        debug {
            // Debug flavor 使用独立 applicationId，方便测试时与正式版并存安装。
        }
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (hasReleaseSigning) {
                signingConfig = signingConfigs.create("formalRelease") {
                    storeFile = file(releaseKeystorePath)
                    storePassword = releaseKeystorePassword
                    keyAlias = releaseKeyAlias
                    keyPassword = releaseKeyPassword
                }
            }
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
