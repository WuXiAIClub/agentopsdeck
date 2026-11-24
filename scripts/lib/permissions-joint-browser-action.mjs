// Arm the response listener before clicking, but observe BOTH promises
// immediately. A disabled button may outlive the response timeout; awaiting
// click first otherwise turns that timeout into an unhandled rejection and
// bypasses the probe's failure receipt and cleanup.
export async function jointBrowserAction(waitForResponse, action) {
  const pending = waitForResponse();
  const [response] = await Promise.all([pending, Promise.resolve().then(action)]);
  return response;
}
