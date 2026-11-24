#include <cstdint>

#include "bindings/bindings.h"

extern "C" {
// The age check (#953): Swift's own (linger-client_iOS/AgeCheck.swift), handed
// to Rust before the app starts (src-tauri/src/phone_age.rs). The app links
// the two together; the Rust library alone, which is also linked on its own,
// then needs nothing from the app.
void linger_age_check(void (*answer)(int32_t));
void linger_register_age_check(void (*check)(void (*answer)(int32_t)));
}

int main(int argc, char * argv[]) {
	linger_register_age_check(linger_age_check);
	ffi::start_app();
	return 0;
}
