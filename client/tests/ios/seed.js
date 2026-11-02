// Run by room.yaml, on the Mac, in Maestro's JavaScript (its `http` and
// `json`, and the -e variables): signs in as the host the set-up flow made,
// makes a room called porch, and says something in it. The app hears about
// the room over its gateway, as it would hear about one a co-host made.
function post(path, body, token) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = "Bearer " + token;
  const answer = http.post(SERVER + "/api/v1" + path, { headers: headers, body: JSON.stringify(body) });
  if (answer.status < 200 || answer.status > 299) throw new Error("POST " + path + ": " + answer.status + " " + answer.body);
  return json(answer.body);
}

const signedIn = post("/auth/login", { username: HOST_USERNAME, password: HOST_PASSWORD });
const room = post("/rooms", { slug: "porch", name: "porch", topic: null }, signedIn.access_token);
post("/rooms/" + room.id + "/messages", { body: "Hello from the runner." }, signedIn.access_token);

output.token = signedIn.access_token;
output.roomId = room.id;
