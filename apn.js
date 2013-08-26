
// Apple Push Notification
var apn = require('apn');
var options = { 
	"gateway": "gateway.sandbox.push.apple.com",
	'cert': "cert.pem",
	"key": "key.pem"
};

var apnConnection = new apn.Connection(options);

apnConnection.on('connected', function() {
    console.log("APN Connected");
});	

apnConnection.on('transmitted', function(notification, device) {
    console.log("Notification transmitted to:" + device.token.toString('base64'));
});

apnConnection.on('transmissionError', function(errCode, notification, device) {
    console.error("Notification caused error: " + errCode + " for device ", device, notification);
});

apnConnection.on('timeout', function () {
    console.log("Connection Timeout");
});

apnConnection.on('disconnected', function() {
    console.log("Disconnected from APNS");
});

apnConnection.on('socketError', console.error);

exports.connection = apnConnection;
exports.apn = apn;