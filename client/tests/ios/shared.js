// Run by share-photo.yaml once the share window says Sent: whether the server
// has the message in evenings, with the photo attached, asked until it does
// or 15 seconds have gone by. Says what it found in `output.found`, for the
// log when it hasn't.
function call(method, path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const options = { headers: headers };
  if (body) options.body = JSON.stringify(body);
  const answer = method === "POST" ? http.post(SERVER + "/api/v1" + path, options) : http.get(SERVER + "/api/v1" + path, options);
  if (answer.status < 200 || answer.status > 299) throw new Error(method + " " + path + ": " + answer.status + " " + answer.body);
  return json(answer.body);
}

const token = call("POST", "/auth/login", { username: HOST_USERNAME, password: HOST_PASSWORD }).access_token;
const room = call("GET", "/rooms", null, token).filter(function (each) {
  return each.slug === "evenings";
})[0];
if (!room) throw new Error("no room called evenings");

const deadline = Date.now() + 15000;
output.shared = false;
output.found = "nothing yet";
while (!output.shared && Date.now() < deadline) {
  const messages = call("GET", "/rooms/" + room.id + "/messages?limit=10", null, token);
  const message = messages.filter(function (each) {
    return each.body === "From the share sheet.";
  })[0];
  if (message) {
    output.found = JSON.stringify(message.attachments.map(function (each) {
      return { filename: each.filename, mime: each.mime, size_bytes: each.size_bytes, width: each.width, height: each.height };
    }));
    output.shared = message.attachments.length === 1 && message.attachments[0].mime.indexOf("image/") === 0;
  }
}
console.log("the shared message's attachments: " + output.found);
