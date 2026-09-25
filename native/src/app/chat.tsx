import Feather from '@expo/vector-icons/Feather';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Linking, Pressable, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BRAND } from '@/lib/api';
import { currentLang_, t as i18nT } from '@/lib/i18n';

/**
 * "Chat with us" — a full-screen modal like Ask Hawkeye, with the support chat
 * (Intercom) inside it. Intercom's SDK is not in the app: this is our own web
 * chat page in a WebView. ?chat=1 opens the messenger on arrival and &embed=1
 * hides the rest of the page (app/chat.js), so the screen is just the chat.
 * The WebView keeps its own cookies, so a returning observer keeps their
 * conversation. Closing the messenger closes this screen (chat.js posts
 * 'chat-closed').
 */
const CHAT_URL = 'https://hawkeye.com.ng/about.html?chat=1&embed=1';

/** Hosts the chat may load; anything else (a link someone sends) opens outside. */
const INSIDE = /^https:\/\/([a-z0-9-]+\.)*(hawkeye\.com\.ng|intercom\.io|intercomcdn\.com|intercomassets\.com|intercom-messenger\.com|intercomusercontent\.com)(\/|$)/i;

export default function ChatScreen() {
  const [loading, setLoading] = useState(true);
  // The page is in the APP's language, and never shows the web's first-visit
  // language prompt: set before any of its scripts run.
  const lang = currentLang_();
  // Also hide the page itself BEFORE it paints — chat.js hides it too, but only
  // once it runs, so the web contact page flashed for half a second first.
  const boot = `try{localStorage.setItem('hawkeye_lang','${lang}');localStorage.setItem('hawkeye_lang_prompted','1');}catch(e){}`
    + `try{var s=document.createElement('style');s.textContent='body>:not([id^="intercom"]):not([class*="intercom"]){display:none!important}html,body{background:transparent!important}';document.documentElement.appendChild(s);}catch(e){}true;`;
  // NO header of ours: Intercom's messenger already carries the Hawkeye logo and
  // a close (×) that closes this screen ('chat-closed'); a second bar on top of
  // it was redundant and clipped the messenger's own header. The status-bar strip
  // is Hawkeye green so it runs into the messenger's green header.
  const insets = useSafeAreaInsets();
  return (
    <View className="flex-1 bg-surface" style={{ paddingTop: insets.top, backgroundColor: '#004225' }}>
      <View className="flex-1 bg-surface">
        <WebView
          source={{ uri: CHAT_URL }}
          injectedJavaScriptBeforeContentLoaded={boot}
          javaScriptEnabled
          domStorageEnabled
          sharedCookiesEnabled
          thirdPartyCookiesEnabled
          setSupportMultipleWindows={false}
          // iOS must not add its own safe-area inset to the page: the frame is
          // already below the status bar, and the extra inset shifted the
          // messenger so its header was clipped.
          contentInsetAdjustmentBehavior="never"
          automaticallyAdjustContentInsets={false}
          // The spinner stays until the messenger is actually on screen
          // ('chat-shown' from chat.js), not merely until the page loaded.
          onLoadEnd={() => setTimeout(() => setLoading(false), 15000)}
          onMessage={(e) => {
            if (e.nativeEvent.data === 'chat-shown') setLoading(false);
            if (e.nativeEvent.data === 'chat-closed') router.back();
          }}
          onShouldStartLoadWithRequest={(req) => {
            if (INSIDE.test(req.url) || req.url.startsWith('about:')) return true;
            Linking.openURL(req.url).catch(() => {});
            return false;
          }}
          style={{ flex: 1, backgroundColor: 'transparent' }}
        />
        {loading ? (
          <View className="absolute inset-0 items-center justify-center">
            <ActivityIndicator color={BRAND.gold} />
            {/* The messenger's own × is not there yet — never leave the user stuck. */}
            <Pressable
              onPress={() => router.back()}
              hitSlop={12}
              accessibilityRole="button"
              accessibilityLabel={i18nT('common.close')}
              className="absolute right-4 top-3 h-9 w-9 items-center justify-center rounded-full bg-card"
            >
              <Feather name="x" size={18} color={BRAND.gold} />
            </Pressable>
          </View>
        ) : null}
      </View>
    </View>
  );
}
