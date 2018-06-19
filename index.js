const assert = require('assert');
const fetch = require('node-fetch');
const debug = require('debug')('gigya-approuter');
debug('[Info]: Starting Gigya Approuter extension based application');

// Find Gigya service configuration
const VCAP_SERVICES = process.env.VCAP_SERVICES && JSON.parse(process.env.VCAP_SERVICES) || require(process.cwd() + '/default-services.json');
const gigyaKey = Object.keys(VCAP_SERVICES).find(key => VCAP_SERVICES[key][0] && VCAP_SERVICES[key][0].tags && VCAP_SERVICES[key][0].tags.indexOf('gigya') >=0);
assert(gigyaKey, 'Gigya service configuration not found. Check VCAP_SERVICES environment variable or default-services.json contain service with tag "gigya"')
const gigyaService = VCAP_SERVICES[gigyaKey][0];
const gigyaDefaultHost = 'https://gigya-gw-sarah.cfapps.sap.hana.ondemand.com';
const gigyaHost = gigyaService.credentials.host || gigyaDefaultHost;
if(!gigyaService.credentials.host) {
    debug('[Warning]: No Gigya host found in binding information. Default host will be used instead.')
}

// Start Approuter
const approuter = require('@sap/approuter');
const ar = approuter();
ar.beforeRequestHandler.use(consentManagementMiddleware);
ar.start();

// Consent page
function consentPage(user, pdf) {
    return `<!doctype html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>User Consent Required</title>
    <style>
        .bg {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background: linear-gradient(to bottom,#a9c4df,#e7ecf0);
            display: flex;
            align-items: center;
            justify-content: center;
        }
        .dialog {
            background: white;
            border: none;
            border-radius: 0.25rem;
            box-shadow: 0 0.625rem 1.875rem 0 rgba(0,0,0,0.15), 0 0 0 1px rgba(0,0,0,0.15);
            overflow: hidden;
            max-width: 80%;
            max-height: 70%;
            width: 80%;
            height: 70%;
            font-family: Arial,Helvetica,sans-serif;
        }
        .dialog > header {
            display: flex;
            flex-direction: row;
            align-items: center;           
            height: 3.25rem;
            line-height: 3.25rem;
            padding: 0 2rem;
            border-bottom: 1px solid #eee;
            background-color: #fff;
            color: #0c73b5;
            text-shadow: 0 0 0.125rem #fff;
        }
        .dialog > main {
            font-size: 0;
        }
        .dialog > footer {
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: flex-end;
            height: 2.5rem;
            padding: 0 0.5rem;
            background-color: #f6f6f6;
            border-top: 1px solid #e6e6e7;
        }
        .dialog > footer > button {
            margin: 0 0.25rem;
            line-height: 1.5rem;
            border: none;
            border-radius: 0.1875rem;
            background-color: transparent;
            color: rgb(202, 228, 251);
            text-shadow: 0 0 0.125rem #000000;
            font-family: Arial,Helvetica,sans-serif;
            font-size: 0.875rem;
            text-align: center;
            cursor: pointer;
        }
        .dialog > footer > button:hover {
            background-color: rgba(99, 127, 153, 0.5);
        }

        .pdfobject{
            display: flex;
            width: 100%;
            height: 100%;
            padding: 32px;
        }
    </style>
    <script>
        function declineConsent() {
            fetch(location.href, {
                method: 'HEAD',
                headers: {
                    'X-Gigya-Consent': 'decline'
                }, 
                credentials: 'include'
            }).then(res => { 
                if(res.headers.get('location')) {
                    location.href = res.headers.get('location'); 
                } else {
                    location.reload();
                }
            }).catch(err => 
                console.log(err)
            )            
        }
        function acceptConsent() {
            fetch(location.href, {
                method: 'HEAD',
                headers: {
                    'X-Gigya-Consent': 'accept'
                }, 
                credentials: 'include'
            }).then(() => 
                location.reload()
            ).catch(err => 
                console.log(err)
            );
        }
    </script>
</head>
<body>
    <div class="bg">
        <div class="dialog">
            <header>Consent Request</header>
            <main>
                <object class="pdfobject" type="application/pdf" data="${pdf}?#zoom=75&scrollbar=0&toolbar=0&navpanes=0" id="pdf_content">
                    <p>Your browser is not able to present PDF file. Please download a PDF file from <a></a></p>
                </object>
            </main>
            <footer>
                <button onclick="acceptConsent()">I agree</button>
                <button onclick="declineConsent()">Decline</button>                
            </footer>    
        </div>
    </div>
</body>
</html>`;
}

// Call Gigya Gateway with credentials from service binding
async function gigya(url, opts = {}) {
    const consentResponse = await fetch(`${gigyaHost}${url}`, Object.assign({
        headers: {
            'X-Gigya-Api-Key': gigyaService.credentials.apiKey,
            'X-Gigya-Secret-Key': gigyaService.credentials.secretKey,
            'X-Gigya-User-Key': gigyaService.credentials.userKey,
            'X-Gigya-Name': gigyaService.name,
            'Content-Type': 'application/json'
        }
    }, opts));
    const json = await consentResponse.json();
    if(json.hasOwnProperty('error')) {
        throw new Error(`${json.error}: ${json.message}`);
    }
    return json;
}

// Consent management
async function consentManagementMiddleware(req, res, next) {
    try {
        // Consent page form submit?
        if(req.headers['x-gigya-consent']) {
            if(req.headers['x-gigya-consent'] === 'accept') {
                // Save consent
                debug('[Info]: Saving consent profile to Gigya Gateway');
                await gigya(`/consent/config?userId=${req.user.id}`, {
                    method: 'POST',
                    body: '{"isConsentGranted": true}'
                });
                debug('[Info]: Consent profile saved to Gigya Gateway');
                req.session.gigyaConsentGranted = true;
                req.session.save();
                res.statusCode = 204;
                return res.end();
            } else if(req.headers['x-gigya-consent'] === 'decline') {
                if(req.session.gigyaProfile.isRequired === 'true') {
                    res.statusCode = 204;
                    res.setHeader('Location', req.routerConfig.appConfig.logout.logoutEndpoint);
                    return res.end();
                } else {
                    req.session.gigyaConsentGranted = true;
                    req.session.save();
                    res.statusCode = 204;
                    return res.end();
                }
            }
        }

        // Consent granted
        if(req.session.gigyaConsentGranted) {
            debug('[Info]: According to session information, user consent is already granted');
            return next();
        }

        // Get consent profile of the user
        debug('[Info]: Fetching consent profile from Gigya Gateway');
        const profile = await gigya(`/consent/profile?userId=${req.user.id}`);
        debug('[Info]: Consent profile successfully fetched');
        req.session.gigyaProfile = profile;
        req.session.save();

        // Need to show consent page?
        if (profile.isLoginEnabled) {
            debug('[Info]: According to profile, user consent is already granted');
            req.session.gigyaConsentGranted = true;
            req.session.save();
            next();
        } else {
            debug('[Info]: User consent is required. Serving user consent page');
            res.statusCode = 200;
            res.end(consentPage(req.user, profile.documentUrl));
        }
    } catch(err) {
        debug('[Error]: ' + err.message);
        res.statusCode = 500;
        res.end();
    }
}
