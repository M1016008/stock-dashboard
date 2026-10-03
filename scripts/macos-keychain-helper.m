#import <Foundation/Foundation.h>
#import <Security/Security.h>

static int fail(int code) {
  return code;
}

int main(int argc, const char *argv[]) {
  @autoreleasepool {
    if (argc < 4) return fail(2);
    NSString *operation = [NSString stringWithUTF8String:argv[1]];
    NSString *service = [NSString stringWithUTF8String:argv[2]];
    NSString *account = [NSString stringWithUTF8String:argv[3]];
    NSDictionary *baseQuery = @{
      (__bridge id)kSecClass: (__bridge id)kSecClassGenericPassword,
      (__bridge id)kSecAttrService: service,
      (__bridge id)kSecAttrAccount: account,
    };

    if ([operation isEqualToString:@"get"]) {
      NSMutableDictionary *query = [baseQuery mutableCopy];
      query[(__bridge id)kSecReturnData] = @YES;
      query[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
      CFTypeRef result = NULL;
      OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)query, &result);
      if (status == errSecItemNotFound) return fail(44);
      if (status != errSecSuccess || result == NULL) return fail(45);
      NSData *data = CFBridgingRelease(result);
      [[NSFileHandle fileHandleWithStandardOutput] writeData:data];
      return 0;
    }

    if ([operation isEqualToString:@"set"]) {
      if (argc < 5) return fail(2);
      NSString *label = [NSString stringWithUTF8String:argv[4]];
      NSData *secret = [[NSFileHandle fileHandleWithStandardInput] readDataToEndOfFile];
      if (secret.length == 0) return fail(2);
      NSDictionary *update = @{
        (__bridge id)kSecValueData: secret,
        (__bridge id)kSecAttrLabel: label,
      };
      OSStatus status = SecItemUpdate(
        (__bridge CFDictionaryRef)baseQuery,
        (__bridge CFDictionaryRef)update
      );
      if (status == errSecSuccess) return 0;
      if (status != errSecItemNotFound) return fail(45);
      NSMutableDictionary *add = [baseQuery mutableCopy];
      [add addEntriesFromDictionary:update];
      status = SecItemAdd((__bridge CFDictionaryRef)add, NULL);
      return status == errSecSuccess ? 0 : fail(45);
    }

    return fail(2);
  }
}
