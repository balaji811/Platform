
import express from "express";
import bodyparser from "body-parser";
import pg from "pg";
import { Server } from "socket.io";
import http from "http";
import env from "dotenv";
import session from "express-session";
import { PythonShell } from "python-shell"; 
import { exec } from 'child_process';
import path from "path";
import { fileURLToPath } from "url";


// Fix __dirname in ES modules
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);


env.config();

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const port = 3000;

// DB connection
const db = new pg.Client({
  user: process.env.PG_USER,
  host: process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port: process.env.PG_PORT,
});
db.connect();

// Middleware
app.set("view engine", "ejs");

app.use(express.static("public"));
app.use(bodyparser.urlencoded({ extended: true }));
app.use(bodyparser.json());
app.use(session({
  secret: process.env.SESSION_SECRET || "secretkey",
  resave: false,
  saveUninitialized: false
}));



function studentAuth(req, res, next) {
  if (!req.session.userId) {
    return res.redirect("/student/log");
  }
  // Prevent browser caching
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
}

function companyAuth(req, res, next) {
  if (!req.session.companyId) {
    return res.redirect("/company/log");
  }
  // Prevent browser caching
  res.set("Cache-Control", "no-store, no-cache, must-revalidate, private");
  next();
}


io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Join room by student + company
  socket.on('joinRoom', ({ studentId, companyId }) => {
    const room = `room_${companyId}_${studentId}`;
    socket.join(room);
  });

  // Send message
  socket.on('sendMessage', async ({ studentId, companyId, sender, message }) => {
    const room = `room_${companyId}_${studentId}`;

    // Save message to DB
    await db.query(
      "INSERT INTO chats (company_id, student_id, sender, message) VALUES ($1, $2, $3, $4)",
      [companyId, studentId, sender, message]
    );

    // Emit message to room
    io.to(room).emit('receiveMessage', { sender, message, timestamp: new Date() });
  });
});


//609 company details interface



// Routes
app.get("/", (req, res) => {
  res.render("index.ejs");
});



//**** student login ******

// Student Register Page
app.get("/student", (req, res) => {
  res.render("loginstd/registerstd.ejs");
});

app.post("/student/register", async (req, res) => {
  const { name, email, password } = req.body;
  try {
    const existing = await db.query("SELECT * FROM students WHERE email = $1", [email]);
    if (existing.rows.length > 0) {
      return res.status(400).send("Email already registered");
    }

    await db.query(
      "INSERT INTO students (name, email, password) VALUES ($1, $2, $3)",
      [name.trim(), email.trim(), password.trim()]
    );

    res.render("/student/log");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error inserting data");
  }
});


// Student Login Page
app.get("/student/log", (req, res) => {
  res.render("loginstd/loginstd.ejs");
});

app.post("/student/login", async (req, res) => {
  const email = req.body.email?.trim();
  const password = req.body.password?.trim();

  if (!email || !password) {
    return res.status(400).send("Email and password are required");
  }

  try {
    const result = await db.query(
      "SELECT * FROM students WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(401).send("Invalid credentials");
    }

    const user = result.rows[0];

    if (password === user.password) {
      req.session.userId = user.id;
      return res.redirect("/student/mainpage");
    } else {
      return res.status(401).send("Invalid credentials");
    }
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).send("Server error");
  }
});





// *********student info***************




app.get('/student/mainpage', studentAuth, async (req, res) => {
  try {
    const studentId = req.session.userId;

    if (!studentId) {
      return res.redirect("/student/log"); // force login
    }

    // Fetch student data
    const studentQuery = await db.query('SELECT * FROM students WHERE id = $1', [studentId]);
    const student = studentQuery.rows[0];

    // Fetch all job postings
    const jobsQuery = await db.query('SELECT * FROM job_postings WHERE opportunity_type = $1', ['job']);
    const job_postings = jobsQuery.rows;

    // Fetch all internships
    const internshipsQuery = await db.query('SELECT * FROM job_postings WHERE opportunity_type = $1', ['internship']);
    const internships = internshipsQuery.rows;

    // Total jobs count
    const totalJobs = job_postings.length;

    // Fetch only companies that already have chats with this student
    const chattedCompaniesQuery = await db.query(
      `SELECT DISTINCT c.* 
       FROM companies c
       JOIN chats ch ON ch.company_id = c.id
       WHERE ch.student_id = $1`,
      [studentId]
    );
    const companies = chattedCompaniesQuery.rows;

    // Render EJS page
    res.render("student/mainpage.ejs", {
      student,
      job_postings,
      internships,
      companies,  // only companies with chat
      totalJobs
    });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});



//***********Dashboard */
app.get("/dashboard", studentAuth, async (req, res) => {
  const studentId = req.session.userId; // stored at login

  if (!studentId) {
    return res.redirect("/login"); // no session, redirect
  }

  const pythonPath = "python"; // or "python3" if needed
  const scriptPath = path.join(__dirname, "ml", "recommend_jobs.py");

  exec(`${pythonPath} "${scriptPath}" ${studentId}`, (error, stdout, stderr) => {
    if (error) {
      console.error("Error running ML script:", error);
      return res.render("student/dashboard.ejs", { jobs: [], error: "⚠️ Error running ML script" });
    }

    try {
      const jobs = JSON.parse(stdout.trim());
      res.render("student/dashboard.ejs", { jobs, error: null });
    } catch (err) {
      console.error("JSON parse error:", err);
      console.error("Raw output:", stdout);
      res.render("student/dashboard.ejs", { jobs: [], error: "⚠️ Error processing ML output" });
    }
  });
});

// ******* student resume ***********



app.get("/student/resume", studentAuth, async (req, res) => {
  const studentId = req.session.userId;
  if (!studentId) return res.redirect("/student/log");

  const result = await db.query("SELECT * FROM resumes WHERE student_id = $1", [studentId]);
  if (result.rows.length > 0) {
    const resume = result.rows[0];
    res.render("student/viewresume.ejs", { resume });
  } else {
    // get student email to prefill if needed
    const studentQuery = await db.query("SELECT email FROM students WHERE id = $1", [studentId]);
    const email = studentQuery.rows[0]?.email || "";
    res.render("student/resume.ejs", { email });
  }
});




app.post("/student/resumepost", async (req, res) => {
  try {
    const studentId = req.session.userId;
    if (!studentId) return res.redirect("/student/log");

    // get email to keep consistency (optional)
    const studentQuery = await db.query("SELECT email FROM students WHERE id = $1", [studentId]);
    const student = studentQuery.rows[0];
    if (!student) return res.redirect("/student/log");
    const email = student.email;

    const {
      fullName, jobTitle, phone, location, linkedin,
      school, degree, gradYear, company, jobTitleWork,
      workDate, workDescription, skills, summary
    } = req.body;

    await db.query(
      `INSERT INTO resumes 
      (student_id, full_name, job_title, email, phone, location, linkedin, 
       school, degree, grad_year, company, job_title_work, work_date, 
       work_description, skills, summary) 
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
      [studentId, fullName, jobTitle, email, phone, location, linkedin,
       school, degree, gradYear, company, jobTitleWork, workDate,
       workDescription, skills, summary]
    );

    res.send("Resume saved successfully!");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error saving resume");
  }
});






//edit student resume
app.get("/student/resume/edit", async (req, res) => {
  try {
    const studentId = req.session.userId;
    if (!studentId) return res.redirect("/student/log");

    // Get student email
    const studentQuery = await db.query(
      "SELECT email FROM students WHERE id = $1",
      [studentId]
    );
    const student = studentQuery.rows[0];
    if (!student) return res.redirect("/student/log");

    // Get resume
    const resumeQuery = await db.query(
      "SELECT * FROM resumes WHERE email = $1",
      [student.email]
    );
    if (resumeQuery.rows.length === 0) {
      return res.redirect("/student/resume"); // no resume yet
    }

    res.render("student/editResume.ejs", { resume: resumeQuery.rows[0] });
  } catch (err) {
    console.error("Error loading edit page:", err);
    res.status(500).send("Error loading edit page");
  }
});




app.post("/student/resume/edit", async (req, res) => {
  try {
    const {
      full_name, job_title, email, phone, location, linkedin,
      school, degree, grad_year, company, job_title_work,
      work_date, work_description, skills, summary
    } = req.body;

    await db.query(
      `UPDATE resumes SET 
        full_name=$1, job_title=$2, phone=$3, location=$4, linkedin=$5, 
        school=$6, degree=$7, grad_year=$8, company=$9, job_title_work=$10,
        work_date=$11, work_description=$12, skills=$13, summary=$14
      WHERE email=$15`,
      [
        full_name, job_title, phone, location, linkedin,
        school, degree, grad_year, company, job_title_work,
        work_date, work_description, skills, summary, email
      ]
    );

    res.redirect("/student/resume");
  } catch (err) {
    console.error("Error updating resume:", err);
    res.status(500).send("Error updating resume");
  }
});



//**** student apply*****

app.get("/job/:id", async (req, res) => {
  const jobId = req.params.id;
  try {
    const jobResult = await db.query("SELECT * FROM job_postings WHERE id = $1", [jobId]);
    if (jobResult.rows.length === 0) {
      return res.status(404).send("Job not found");
    }
    const job = jobResult.rows[0];
    res.render("student/jobdetails.ejs", { job }); 
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error");
  }
});



app.post("/apply/:jobId", async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const studentId = req.session.userId;

    if (!studentId) {
      return res.redirect("/student/log"); // must be logged in
    }

    // 1. Check if the student already applied for this job
    const existingApp = await db.query(
      "SELECT * FROM applications WHERE student_id = $1 AND job_id = $2",
      [studentId, jobId]
    );

    if (existingApp.rows.length > 0) {
      return res.redirect("/student/applications");
    }

    // 2. Get the student's latest resume
    const resumeResult = await db.query(
      "SELECT id FROM resumes WHERE student_id = $1 ORDER BY id DESC LIMIT 1",
      [studentId]
    );

    if (resumeResult.rows.length === 0) {
      return res.redirect("/student/resume");
    }

    const resumeId = resumeResult.rows[0].id;

    // 3. Insert new application with status = 'pending'
    await db.query(
      `INSERT INTO applications (student_id, job_id, resume_id, status) 
       VALUES ($1, $2, $3, $4)`,
      [studentId, jobId, resumeId, "pending"]
    );

    res.redirect("/student/applications"); 
    // instead of res.send(), redirect to student’s applications page

  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error applying to job");
  }
});











// ****** student applications ***** 
// 📄 Student Applications Page
app.get("/student/applications", studentAuth, async (req, res) => {
  try {
    const studentId = req.session.userId; // logged-in student ID

    if (!studentId) {
      return res.redirect("/student/log"); // redirect if not logged in
    }

    // 🔹 Fetch applications with job + company + resume details
    const result = await db.query(
      `SELECT 
          a.id AS application_id,
          a.applied_at,
           a.status,  
          j.job_title,
          j.opportunity_type,
          j.company_name,
          r.full_name AS resume_name,
          r.email AS resume_email
       FROM applications a
       JOIN job_postings j ON a.job_id = j.id
       JOIN resumes r ON a.resume_id = r.id
       WHERE a.student_id = $1
       ORDER BY a.applied_at DESC`,
      [studentId]
    );

    const applications = result.rows;

    res.render("student/stapplications.ejs", { applications });

  } catch (err) {
    console.error("Error fetching applications:", err);
    res.status(500).send("Server error while fetching applications");
  }
});




//*** student chat list****
app.get('/student/chats', studentAuth, async (req, res) => {
  try {
    const studentId = req.session.userId;

    if (!studentId) {
      return res.redirect("/student/log"); // force login
    }

    // Fetch only companies that already have chats with this student
    const chattedCompaniesQuery = await db.query(
      `SELECT DISTINCT c.* 
       FROM companies c
       JOIN chats ch ON ch.company_id = c.id
       WHERE ch.student_id = $1`,
      [studentId]
    );
    const companies = chattedCompaniesQuery.rows;

    // Render the simplified EJS page
    res.render("student/chatlist.ejs", { companies });

  } catch (err) {
    console.error(err);
    res.status(500).send('Server Error');
  }
});

// Student chat page
app.get('/student/chat/:companyId', async (req, res) => {
  const studentId = req.session.userId;
  const companyId = req.params.companyId;

  if (!studentId) return res.redirect('/student/log');

  // Check if any chat exists
  const chatCheck = await db.query(
    "SELECT * FROM chats WHERE company_id=$1 AND student_id=$2",
    [companyId, studentId]
  );

  if (chatCheck.rows.length === 0) {
    return res.send("⚠️ The company has not started a chat yet.");
  }

  // Fetch all previous messages
  const messagesResult = await db.query(
    "SELECT sender, message, created_at FROM chats WHERE company_id=$1 AND student_id=$2 ORDER BY created_at ASC",
    [companyId, studentId]
  );
  const messages = messagesResult.rows;

  // Render chat page with messages
  res.render('student/stchat.ejs', { companyId, studentId, messages });
});




// ******** STUDENT LOGOUT ********
app.get("/student/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Logout error:", err);
      return res.status(500).send("Error logging out");
    }

    res.clearCookie("connect.sid"); // default session cookie name
    res.redirect("/student/log");   // redirect to student login
  });
});










//**** company login ******//


//company register
app.get("/company/re", (req,res) => {
    res.render("logincom/registercom.ejs");
});

app.post("/company/register", async (req, res) => {
  const {
    companyName,
    companyWebsite,
    companyDescription,
    industry,
    contactPerson,
    contactPosition,
    email,
    password,
    streetAddress,
    city,
    state,
    postalCode,
    country
  } = req.body;

  try {
    
    const checkEmail = await db.query("SELECT * FROM companies WHERE email = $1", [email]);
    if (checkEmail.rows.length > 0) {
      return res.status(400).send("Email is already registered. Please use another email.");
    }

   
    await db.query(
      `INSERT INTO companies 
      (company_name, company_website, company_description, industry, contact_person, contact_position, email, password, street_address, city, state, postal_code, country) 
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        companyName,
        companyWebsite,
        companyDescription,
        industry,
        contactPerson,
        contactPosition,
        email,
        password,
        streetAddress,
        city,
        state,
        postalCode,
        country
      ]
    );

     res.render("logincom/logincom.ejs");
  } catch (err) {
    console.error("Error inserting company data:", err);
    res.status(500).send("Error registering company");
  }
});



//company login
app.get("/company/log" , (req,res) =>{
 res.render("logincom/logincom.ejs");
});

// Company Login POST route
app.post("/company/login", async (req, res) => {
  const { email, password } = req.body;

  try {
    const result = await db.query(
      "SELECT * FROM companies WHERE email = $1",
      [email]
    );

    if (result.rows.length === 0) {
      return res.status(400).send("Invalid email or password.");
    }

    const company = result.rows[0];

    
    if (company.password !== password) {
      return res.status(400).send("Invalid email or password.");
    }

    req.session.companyEmail = company.email;
    req.session.companyId = company.id;
    res.redirect("/company");
    
  } catch (err) {
    console.error("Error logging in:", err);
    res.status(500).send("Server error during login.");
  }
});



// ********* company page *********///
//company


app.get("/company",companyAuth, async (req, res) => {
  try {
    const companyResult = await db.query(
      "SELECT * FROM companies WHERE id = $1",
      [req.session.companyId]
    );
    const company = companyResult.rows[0];

    // Fetch students who applied to this company's jobs
    const studentsResult = await db.query(
      `SELECT DISTINCT s.id, s.name, s.email
       FROM students s
       JOIN applications a ON a.student_id = s.id
       JOIN job_postings j ON a.job_id = j.id
       WHERE j.company_email = $1`,
      [company.email]
    );
    const students = studentsResult.rows;

    res.render("company/company.ejs", { company, students });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading company details");
  }
});




//update company details
app.get("/company/edit",companyAuth,  async (req, res) => {
     if (!req.session.companyEmail) {
    return res.redirect('/company/log');
  }
  
    try {
        const result = await db.query("SELECT * FROM companies WHERE id = $1", [req.session.companyId]);
        const company = result.rows[0];
        res.render("company/editcompany.ejs", { company }); // ✅ Pass company to EJS
    } catch (err) {
        console.error(err);
        res.status(500).send("Error loading company details");
    }
});


app.post("/company/update",companyAuth,  async (req, res) => {
  const {
    company_name,
    company_website,
    company_description,
    industry,
    contact_person,
    contact_position,
    email, // unique - used in WHERE
    password,
    street_address,
    city,
    state,
    postal_code,
    country
  } = req.body;

  try {
    await db.query(
      `UPDATE companies 
       SET company_name = $1,
           company_website = $2,
           company_description = $3,
           industry = $4,
           contact_person = $5,
           contact_position = $6,
           password = $7,
           street_address = $8,
           city = $9,
           state = $10,
           postal_code = $11,
           country = $12
       WHERE email = $13`,
      [
        company_name,
        company_website,
        company_description,
        industry,
        contact_person,
        contact_position,
        password,
        street_address,
        city,
        state,
        postal_code,
        country,
        email
      ]
    );

    res.redirect("/company/edit");
  } catch (err) {
    console.error(err);
    res.status(500).send("Error updating company");
  }
});



//********job-post *****/

app.get('/company/postjob',companyAuth,  async (req, res) => {
  if (!req.session.companyEmail) {
    return res.redirect('/company/log');
  }
  
  const companyEmail = req.session.companyEmail;
  const result = await db.query('SELECT company_name FROM companies WHERE email = $1', [companyEmail]);
  if (result.rows.length === 0) return res.status(404).send('Company not found');

  res.render('company/post-jobs.ejs', {
    companyName: result.rows[0].company_name,
    companyEmail: companyEmail
  });
});



app.post('/jobs/post',companyAuth,  async (req, res) => {
  const {
    companyName,
    companyEmail,
    companyWebsite,
    companyDescription,
    opportunityType,
    stipendAmount,
    salaryRange,
    jobTitle,
    jobType,
    jobDescription,
    skills,
    workArrangement,
    officeAddress,
    workingHours,
    timezone,
    applicationDeadline,
    startDate,
    contactEmail,
  } = req.body;

  try {
    const query = `
      INSERT INTO job_postings (
        company_name,
        company_email,
        company_website,
        company_description,
        opportunity_type,
        stipend_amount,
        salary_range,
        job_title,
        job_type,
        job_description,
        skills,
        work_arrangement,
        office_address,
        working_hours,
        timezone,
        application_deadline,
        start_date,
        contact_email
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17, $18
      ) RETURNING id;
    `;

    const values = [
      companyName,
      companyEmail,
      companyWebsite || null,
      companyDescription,
      opportunityType,
      stipendAmount || null,
      salaryRange || null,
      jobTitle,
      jobType,
      jobDescription,
      skills || null,
      workArrangement,
      officeAddress || null,
      workingHours || null,
      timezone || null,
      applicationDeadline || null,
      startDate || null,
      contactEmail,
    ];

    const result = await db.query(query, values);

    res.redirect("/company/posted"); // Redirect after successful posting
  } catch (error) {
    console.error('Error inserting job posting:', error);
    res.status(500).send('Server Error: Unable to post job.');
  }
}); 


app.get('/company/job/edit/:jobId', companyAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const companyId = req.session.companyId;

    const result = await db.query(
      "SELECT * FROM job_postings WHERE id = $1 AND company_email = (SELECT email FROM companies WHERE id = $2)",
      [jobId, companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).send("Job not found or you don't have permission to edit it.");
    }

    const job = result.rows[0];
    res.render('company/edit-jobs.ejs', { job }); // Render form with job data

  } catch (err) {
    console.error("Error loading job edit page:", err);
    res.status(500).send("Server error");
  }
});



app.post('/company/job/update/:jobId', companyAuth, async (req, res) => {
  try {
    const jobId = req.params.jobId;
    const companyId = req.session.companyId;

    const {
      jobTitle,
      jobType,
      opportunityType,
      jobDescription,
      skills,
      stipendAmount,
      salaryRange,
      workArrangement,
      officeAddress,
      workingHours,
      timezone,
      applicationDeadline,
      startDate,
      contactEmail
    } = req.body;

    const result = await db.query(
      `UPDATE job_postings SET
         job_title = $1,
         job_type = $2,
         opportunity_type = $3,
         job_description = $4,
         skills = $5,
         stipend_amount = $6,
         salary_range = $7,
         work_arrangement = $8,
         office_address = $9,
         working_hours = $10,
         timezone = $11,
         application_deadline = $12,
         start_date = $13,
         contact_email = $14
       WHERE id = $15 AND company_email = (SELECT email FROM companies WHERE id = $16)`,
      [
        jobTitle,
        jobType,
        opportunityType,
        jobDescription,
        skills,
        stipendAmount || null,
        salaryRange || null,
        workArrangement,
        officeAddress || null,
        workingHours || null,
        timezone || null,
        applicationDeadline || null,
        startDate || null,
        contactEmail,
        jobId,
        companyId
      ]
    );

    if (result.rowCount === 0) {
      return res.status(404).send("Job not found or you don't have permission to update it.");
    }

    res.redirect('/company/posted'); // redirect to posted jobs page

  } catch (err) {
    console.error("Error updating job:", err);
    res.status(500).send("Server error");
  }
});








//******posted job *******///
app.get('/company/posted',companyAuth,  async (req, res) => {
  if (!req.session.companyEmail) {
    return res.redirect('/company/log');
  }

  try {
    const companyEmail = req.session.companyEmail;
    const result = await db.query(
      'SELECT * FROM job_postings WHERE company_email = $1 ORDER BY created_at DESC',
      [companyEmail]
    );

    res.render("company/job-list.ejs", {
      jobs: result.rows,
      companyEmail: companyEmail
    });
  } catch (err) {
    console.error(err);
    res.status(500).send('Server error');
  }
});


//**** applications in company *******


// Company - View Applications
app.get("/company/applications",companyAuth,  async (req, res) => {
  try {
    const companyEmail = req.session.companyEmail;

    if (!companyEmail) {
      return res.redirect("/company/log"); // must log in
    }

    // 1. Get company details
    const companyResult = await db.query(
      "SELECT id, company_name, email FROM companies WHERE email = $1",
      [companyEmail]
    );
    if (companyResult.rows.length === 0) {
      return res.status(404).send("❌ Company not found");
    }
    const company = companyResult.rows[0];

    // 2. Fetch applications for jobs posted by this company (linked via company_email)
    const applicationsResult = await db.query(
      `SELECT a.id AS application_id, a.applied_at, a.status,
              s.id AS student_id, s.name AS student_name, s.email AS student_email,
              r.full_name AS resume_name, r.email AS resume_email,
              j.job_title, j.skills
       FROM applications a
       JOIN students s ON a.student_id = s.id
       JOIN resumes r ON a.resume_id = r.id
       JOIN job_postings j ON a.job_id = j.id
       WHERE j.company_email = $1
       ORDER BY a.applied_at DESC`,
      [companyEmail]
    );

    res.render("company/comapplications.ejs", {
      company,
      applications: applicationsResult.rows
    });

  } catch (err) {
    console.error("Error in /company/applications:", err);
    res.status(500).send("❌ Error loading applications");
  }
});








// Company - Update Application Status (Accept/Reject)
app.post("/company/applications/:id/status",companyAuth,  async (req, res) => {
  try {
    const applicationId = req.params.id;
    const { status } = req.body; // "accepted" or "rejected"

    if (!["pending", "accepted", "rejected"].includes(status)) {
      return res.status(400).send("❌ Invalid status");
    }

    await db.query(
      "UPDATE applications SET status = $1 WHERE id = $2",
      [status, applicationId]
    );

    res.redirect("/company/applications");

  } catch (err) {
    console.error(err);
    res.status(500).send("❌ Error updating application status");
  }
});

//****company chat list with students */
app.get("/company/chat_list",companyAuth, async (req, res) => {
  try {
    // Fetch company info
    const companyResult = await db.query(
      "SELECT * FROM companies WHERE id = $1",
      [req.session.companyId]
    );
    const company = companyResult.rows[0];

    // Fetch distinct students who applied to this company's jobs
    const studentsResult = await db.query(
      `SELECT DISTINCT s.id, s.name, s.email
       FROM students s
       JOIN applications a ON a.student_id = s.id
       JOIN job_postings j ON a.job_id = j.id
       WHERE j.company_email = $1`,
      [company.email]
    );
    const students = studentsResult.rows;

    // Render the EJS page
    res.render("company/cchatlist.ejs", { company, students });
  } catch (err) {
    console.error(err);
    res.status(500).send("Error loading students");
  }
});













// Company chat page - start chat with a student
app.get('/company/chat/:studentId',companyAuth,  async (req, res) => {
  const companyId = req.session.companyId;
  const studentId = req.params.studentId;

  if (!companyId) return res.redirect('/company/log'); // ensure login

  // Optional: fetch previous messages
  const messagesResult = await db.query(
    "SELECT sender, message, created_at FROM chats WHERE company_id=$1 AND student_id=$2 ORDER BY created_at ASC",
    [companyId, studentId]
  );

  res.render('company/comchat.ejs', {
    companyId,
    studentId,
    messages: messagesResult.rows
  });
});



// ******** COMPANY LOGOUT ********
app.get("/company/logout", (req, res) => {
  req.session.destroy(err => {
    if (err) {
      console.error("Company logout error:", err);
      return res.status(500).send("Error logging out");
    }

    res.clearCookie("connect.sid"); // clear session cookie
    res.redirect("/company/log");   // redirect to company login
  });
});




// Start server
server.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
