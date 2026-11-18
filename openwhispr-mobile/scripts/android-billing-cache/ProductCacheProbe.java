import com.superwall.sdk.models.product.ProductItemSerializer;
import kotlinx.serialization.json.Json;

/** Characterizes the native cache contract needed by our localized paywall. */
public class ProductCacheProbe {
    public static void main(String[] args) {
        for (String name : new String[]{"primary", "secondary"}) {
            String input = "{\"reference_name\":\"" + name + "\",\"store_product\":{"
                + "\"store\":\"PLAY_STORE\",\"product_identifier\":\"com.openwhispr.pro\","
                + "\"base_plan_identifier\":\"monthly\",\"offer\":{\"type\":\"NO_OFFER\"}}}";
            var serializer = ProductItemSerializer.INSTANCE;
            var fresh = Json.Default.decodeFromString(serializer, input);
            var cached = Json.Default.encodeToString(serializer, fresh);
            var restored = Json.Default.decodeFromString(serializer, cached);
            if (!name.equals(restored.getName())) {
                throw new AssertionError("Cached product lost price binding: " + name);
            }
            System.out.println("Cached price binding retained: " + name);
        }
    }
}
