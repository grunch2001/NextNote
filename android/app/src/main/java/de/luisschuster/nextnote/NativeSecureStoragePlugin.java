package de.luisschuster.nextnote;

import android.content.Context;
import android.content.SharedPreferences;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * Small secrets (the Nextcloud app password), encrypted with an AES key from the Android Keystore.
 * The key cannot be exported, so a copy of the stored values is useless on any other device.
 */
@CapacitorPlugin(name = "NativeSecureStorage")
public class NativeSecureStoragePlugin extends Plugin {

    private static final String KEY_ALIAS = "nextnote.secure";
    private static final String PREFS = "nextnote.secure";
    private static final String TRANSFORMATION = "AES/GCM/NoPadding";

    private SharedPreferences prefs() {
        return getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static synchronized SecretKey key() throws Exception {
        KeyStore ks = KeyStore.getInstance("AndroidKeyStore");
        ks.load(null);
        if (ks.containsAlias(KEY_ALIAS)) return ((KeyStore.SecretKeyEntry) ks.getEntry(KEY_ALIAS, null)).getSecretKey();
        KeyGenerator gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore");
        gen.init(
            new KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .build()
        );
        return gen.generateKey();
    }

    private static String error(Exception e) {
        return e.getMessage() != null ? e.getMessage() : e.toString();
    }

    @PluginMethod
    public void get(PluginCall call) {
        String name = call.getString("key");
        String stored = name != null ? prefs().getString(name, null) : null;
        JSObject ret = new JSObject();
        if (stored == null) {
            call.resolve(ret);
            return;
        }
        try {
            // stored layout: [IV length][IV][ciphertext + GCM tag]
            byte[] data = Base64.decode(stored, Base64.NO_WRAP);
            int ivLen = data[0];
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.DECRYPT_MODE, key(), new GCMParameterSpec(128, data, 1, ivLen));
            byte[] plain = cipher.doFinal(data, 1 + ivLen, data.length - 1 - ivLen);
            ret.put("value", new String(plain, StandardCharsets.UTF_8));
            call.resolve(ret);
        } catch (Exception e) {
            call.reject(error(e));
        }
    }

    @PluginMethod
    public void set(PluginCall call) {
        String name = call.getString("key");
        String value = call.getString("value");
        if (name == null || value == null) {
            call.reject("Schlüssel oder Wert fehlt");
            return;
        }
        try {
            Cipher cipher = Cipher.getInstance(TRANSFORMATION);
            cipher.init(Cipher.ENCRYPT_MODE, key());
            byte[] iv = cipher.getIV();
            byte[] enc = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
            byte[] out = new byte[1 + iv.length + enc.length];
            out[0] = (byte) iv.length;
            System.arraycopy(iv, 0, out, 1, iv.length);
            System.arraycopy(enc, 0, out, 1 + iv.length, enc.length);
            if (!prefs().edit().putString(name, Base64.encodeToString(out, Base64.NO_WRAP)).commit()) {
                call.reject("Speichern fehlgeschlagen");
                return;
            }
            call.resolve();
        } catch (Exception e) {
            call.reject(error(e));
        }
    }

    @PluginMethod
    public void remove(PluginCall call) {
        String name = call.getString("key");
        if (name != null) prefs().edit().remove(name).commit();
        call.resolve();
    }
}
