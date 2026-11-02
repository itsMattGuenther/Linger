// Run by room.yaml after the phone sends its message: whether the server has
// it, asked until it does or 15 seconds have gone by. The app shows a message
// as it's sent, before the server has it, so the screen alone can't say.
const deadline = Date.now() + 15000;
output.sent = false;
while (!output.sent && Date.now() < deadline) {
  const answer = http.get(SERVER + "/api/v1/rooms/" + output.roomId + "/messages?limit=10", {
    headers: { Authorization: "Bearer " + output.token },
  });
  if (answer.status !== 200) throw new Error("GET messages: " + answer.status + " " + answer.body);
  output.sent = json(answer.body).some(function (message) {
    return message.body === "Hello from the iPhone.";
  });
}
